import PostalMime from 'postal-mime';
import { z } from 'zod';
import {
  AppError,
  audit,
  hash,
  mailbox,
  now,
  rateLimit,
  scope,
  uid,
  type Attachment,
  type Env,
  type Message,
  type Principal,
} from './model';

const address = z
  .string()
  .trim()
  .email()
  .max(254)
  .refine((v) => !/[\r\n]/.test(v));
export const sendSchema = z
  .object({
    mailboxId: z.string().uuid(),
    to: z.array(address).min(1).max(50),
    cc: z.array(address).max(50).default([]),
    bcc: z.array(address).max(50).default([]),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(998)
      .refine((v) => !/[\r\n]/.test(v)),
    text: z.string().min(1).max(200000),
    html: z.string().max(500000).optional(),
    attachmentIds: z.array(z.string().uuid()).max(20).default([]),
    replyToId: z.string().optional(),
    idempotencyKey: z.string().uuid(),
    draftId: z.string().uuid().optional(),
  })
  .refine(
    (x) => x.to.length + x.cc.length + x.bcc.length <= 50,
    'At most 50 recipients are allowed.',
  );
export type SendInput = z.infer<typeof sendSchema>;
export function present(m: Message) {
  const { body_key, raw_key, ...rest } = m;
  return {
    ...rest,
    recipients: JSON.parse(m.recipients),
    cc: JSON.parse(m.cc),
    bcc: JSON.parse(m.bcc),
    hasRaw: !!raw_key,
  };
}
export async function listMessages(
  env: Env,
  p: Principal,
  options: {
    mailboxId?: string;
    folder?: string;
    q?: string;
    cursor?: string;
    unread?: boolean;
    starred?: boolean;
    limit?: number;
  },
) {
  const id = p.mailboxId || options.mailboxId;
  if (id) scope(p, id);
  else if (!p.scopes.includes('read')) throw new AppError(403, 'Read access is required');
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (id) {
    where.push('m.mailbox_id=?');
    binds.push(id);
  }
  if (options.starred) {
    where.push("m.starred=1 AND m.folder NOT IN ('trash','spam')");
  } else {
    where.push('m.folder=?');
    binds.push(options.folder || 'inbox');
  }
  if (options.unread) where.push('m.is_read=0');
  if (options.q) {
    where.push(
      "(m.subject LIKE ? ESCAPE '\\' OR m.sender LIKE ? ESCAPE '\\' OR m.snippet LIKE ? ESCAPE '\\')",
    );
    const q = `%${options.q.slice(0, 200).replace(/[\\%_]/g, '\\$&')}%`;
    binds.push(q, q, q);
  }
  if (options.cursor) {
    const [date, id] = options.cursor.split('|');
    if (!date || !id) throw new AppError(400, 'Invalid cursor');
    where.push('(m.created_at<? OR (m.created_at=? AND m.id<?))');
    binds.push(date, date, id);
  }
  const limit = Math.min(100, Math.max(1, options.limit || 40));
  const { results } = await env.DB.prepare(
    `SELECT m.*,b.address AS mailbox_address,b.color AS mailbox_color,(SELECT COUNT(*) FROM attachments a WHERE a.message_id=m.id) AS attachment_count FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<Message>();
  const hasMore = results.length > limit;
  const rows = results.slice(0, limit);
  const last = rows.at(-1);
  return {
    messages: rows.map(present),
    nextCursor: hasMore && last ? `${last.created_at}|${last.id}` : null,
  };
}
export async function getMessage(env: Env, p: Principal, id: string) {
  const m = await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(id).first<Message>();
  if (!m) throw new AppError(404, 'Message not found');
  scope(p, m.mailbox_id);
  const body = await env.MAIL_STORE.get(m.body_key);
  if (!body) throw new AppError(503, 'Message content is temporarily unavailable');
  const attachments = await env.DB.prepare(
    'SELECT id,filename,content_type,size,content_id FROM attachments WHERE message_id=?',
  )
    .bind(id)
    .all();
  return {
    ...present(m),
    ...(await body.json<{ text: string; html?: string }>()),
    attachments: attachments.results,
  };
}
export async function patchMessage(
  env: Env,
  p: Principal,
  id: string,
  patch: { isRead?: boolean; starred?: boolean; folder?: string },
) {
  const m = await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(id).first<Message>();
  if (!m) throw new AppError(404, 'Message not found');
  scope(p, m.mailbox_id);
  const fields: string[] = [];
  const values: (string | number)[] = [];
  if (patch.isRead !== undefined) {
    fields.push('is_read=?');
    values.push(+patch.isRead);
  }
  if (patch.starred !== undefined) {
    fields.push('starred=?');
    values.push(+patch.starred);
  }
  if (patch.folder) {
    fields.push('folder=?');
    values.push(patch.folder);
  }
  if (fields.length)
    await env.DB.prepare(`UPDATE messages SET ${fields.join(',')} WHERE id=?`)
      .bind(...values, id)
      .run();
  return { ok: true };
}
export async function sendMail(env: Env, p: Principal, data: SendInput) {
  scope(p, data.mailboxId, 'send');
  const box = await mailbox(env, data.mailboxId);
  if (box.status !== 'active') throw new AppError(409, 'This mailbox is not active.');
  const domain = await env.DB.prepare('SELECT sending FROM domains WHERE id=?')
    .bind(box.domain_id)
    .first<{ sending: number }>();
  if (!domain?.sending) throw new AppError(409, 'Sending is not yet enabled for this domain.');
  const existing = await env.DB.prepare(
    'SELECT id,status,error FROM messages WHERE mailbox_id=? AND dedupe_key=?',
  )
    .bind(box.id, data.idempotencyKey)
    .first<{ id: string; status: string; error: string | null }>();
  if (existing) return { ...existing, duplicate: true };
  await rateLimit(env, `send:${box.id}`, 30);
  let original: Message | null = null;
  if (data.replyToId) {
    original = await env.DB.prepare('SELECT * FROM messages WHERE id=? AND mailbox_id=?')
      .bind(data.replyToId, box.id)
      .first<Message>();
    if (!original) throw new AppError(404, 'Reply message not found in this mailbox');
  }
  const attachmentIds = [...new Set(data.attachmentIds)];
  const files: Attachment[] = [];
  for (const id of attachmentIds) {
    const file = await env.DB.prepare(
      'SELECT * FROM attachments WHERE id=? AND mailbox_id=? AND message_id IS NULL',
    )
      .bind(id, box.id)
      .first<Attachment>();
    if (!file) throw new AppError(400, 'An attachment is missing or belongs to another message.');
    files.push(file);
  }
  const size =
    new TextEncoder().encode(data.text + (data.html || '')).length +
    files.reduce((n, f) => n + Math.ceil(f.size / 3) * 4, 0) +
    30000;
  if (size > 5 * 1024 * 1024)
    throw new AppError(413, 'This email exceeds the 5 MB sending limit. Remove an attachment.');
  const id = uid(),
    date = now(),
    bodyKey = `mail/${box.id}/${id}/body.json`;
  await env.MAIL_STORE.put(bodyKey, JSON.stringify({ text: data.text, html: data.html }), {
    httpMetadata: { contentType: 'application/json' },
  });
  try {
    await env.DB.prepare(
      "INSERT INTO messages(id,mailbox_id,thread_id,direction,folder,sender,sender_name,recipients,cc,bcc,subject,snippet,body_key,in_reply_to,refs,dedupe_key,is_read,status,size,created_at) VALUES(?,?,?,'outbound','sent',?,?,?,?,?,?,?,?,?,?,?,1,'sending',?,?)",
    )
      .bind(
        id,
        box.id,
        original?.thread_id || id,
        box.address,
        box.name,
        JSON.stringify(data.to),
        JSON.stringify(data.cc),
        JSON.stringify(data.bcc),
        data.subject,
        data.text.slice(0, 200),
        bodyKey,
        original?.message_id || null,
        original?.refs || '',
        data.idempotencyKey,
        size,
        date,
      )
      .run();
  } catch (error) {
    await env.MAIL_STORE.delete(bodyKey);
    const prior = await env.DB.prepare(
      'SELECT id,status FROM messages WHERE mailbox_id=? AND dedupe_key=?',
    )
      .bind(box.id, data.idempotencyKey)
      .first();
    if (prior) return { ...prior, duplicate: true };
    throw error;
  }
  let accepted = false;
  let attempted = false;
  try {
    const attachments = [];
    for (const f of files) {
      const claim = await env.DB.prepare(
        'UPDATE attachments SET message_id=? WHERE id=? AND mailbox_id=? AND message_id IS NULL',
      )
        .bind(id, f.id, box.id)
        .run();
      if (claim.meta.changes !== 1)
        throw new AppError(409, 'This attachment is already attached to another message.');
      const object = await env.MAIL_STORE.get(f.object_key);
      if (!object) throw new AppError(400, 'An attachment could not be loaded');
      attachments.push({
        filename: f.filename,
        type: f.content_type,
        content: await object.arrayBuffer(),
        disposition: 'attachment' as const,
      });
    }
    const headers: Record<string, string> = {};
    if (original?.message_id) {
      headers['In-Reply-To'] = original.message_id;
      headers.References = [original.refs, original.message_id]
        .filter(Boolean)
        .join(' ')
        .slice(-1900);
    }
    attempted = true;
    const result = await env.EMAIL.send({
      from: { email: box.address, name: box.name },
      to: data.to,
      cc: data.cc.length ? data.cc : undefined,
      bcc: data.bcc.length ? data.bcc : undefined,
      subject: data.subject,
      text: data.text,
      html: data.html,
      attachments,
      headers,
    });
    accepted = true;
    const statements = [
      env.DB.prepare("UPDATE messages SET status='accepted',message_id=? WHERE id=?").bind(
        result.messageId,
        id,
      ),
    ];
    if (data.draftId)
      statements.push(
        env.DB.prepare('DELETE FROM drafts WHERE id=? AND mailbox_id=?').bind(data.draftId, box.id),
      );
    await env.DB.batch(statements);
    await audit(env, p.actor, 'mail.sent', box.id, {
      messageId: id,
      recipients: data.to.length + data.cc.length + data.bcc.length,
    });
    return { id, status: 'accepted' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Email could not be sent';
    const definitive = !!(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      String(error.code).startsWith('E_')
    );
    const uncertain = accepted || (attempted && !definitive);
    await env.DB.prepare('UPDATE messages SET status=?,error=? WHERE id=?')
      .bind(
        uncertain ? 'uncertain' : 'failed',
        uncertain
          ? 'Delivery could not be confirmed. Do not resend without checking delivery.'
          : reason,
        id,
      )
      .run();
    if (uncertain) return { id, status: 'uncertain' };
    throw new AppError(502, reason);
  }
}

export async function receiveEmail(message: ForwardableEmailMessage, env: Env) {
  const recipient = message.to.toLowerCase();
  const box = await env.DB.prepare("SELECT * FROM mailboxes WHERE address=? AND status='active'")
    .bind(recipient)
    .first<{ id: string }>();
  if (!box) {
    message.setReject('This mailbox is not available.');
    return;
  }
  if (message.rawSize > 25 * 1024 * 1024) {
    message.setReject('Message exceeds the 25 MB mailbox limit.');
    return;
  }
  const raw = await new Response(message.raw).arrayBuffer();
  const digest = await hash(raw);
  const id = await hash(`${box.id}:${digest}`);
  const duplicate = await env.DB.prepare('SELECT id FROM messages WHERE id=?').bind(id).first();
  if (duplicate) return;
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  const originalId = parsed.inReplyTo;
  const refs = parsed.references || '';
  let threadId = id;
  for (const ref of [originalId, ...refs.split(/\s+/).reverse()].filter(Boolean)) {
    const parent = await env.DB.prepare(
      'SELECT thread_id FROM messages WHERE mailbox_id=? AND message_id=?',
    )
      .bind(box.id, ref)
      .first<{ thread_id: string }>();
    if (parent) {
      threadId = parent.thread_id;
      break;
    }
  }
  const prefix = `mail/${box.id}/${id}`,
    date = now();
  const bodyKey = `${prefix}/body.json`,
    rawKey = `${prefix}/original.eml`;
  await env.MAIL_STORE.put(rawKey, raw, { httpMetadata: { contentType: 'message/rfc822' } });
  await env.MAIL_STORE.put(
    bodyKey,
    JSON.stringify({
      text: parsed.text || '',
      html: parsed.html || '',
      headers: parsed.headers.filter((h) =>
        ['authentication-results', 'received-spf'].includes(h.key),
      ),
    }),
    { httpMetadata: { contentType: 'application/json' } },
  );
  const statements = [
    env.DB.prepare(
      "INSERT OR IGNORE INTO messages(id,mailbox_id,thread_id,direction,folder,sender,sender_name,recipients,cc,reply_to,subject,snippet,body_key,raw_key,message_id,in_reply_to,refs,dedupe_key,status,size,created_at) VALUES(?,?,?,'inbound','inbox',?,?,?,?,?,?,?,?,?,?,?,?,?,'received',?,?)",
    ).bind(
      id,
      box.id,
      threadId,
      parsed.from?.address || message.from,
      parsed.from?.name || '',
      JSON.stringify(parsed.to?.map((a) => ('address' in a ? a.address : a.name)) || [recipient]),
      JSON.stringify(parsed.cc?.map((a) => ('address' in a ? a.address : a.name)) || []),
      parsed.replyTo?.find((a) => 'address' in a)?.address || null,
      parsed.subject || '(No subject)',
      (parsed.text || parsed.html?.replace(/<[^>]*>/g, ' ') || '')
        .replace(/\s+/g, ' ')
        .slice(0, 200),
      bodyKey,
      rawKey,
      parsed.messageId || null,
      originalId || null,
      refs,
      digest,
      raw.byteLength,
      date,
    ),
  ];
  for (let i = 0; i < parsed.attachments.length; i++) {
    const a = parsed.attachments[i];
    const aid = `${id}-${i}`,
      key = `${prefix}/attachments/${i}`;
    const content = a.content as ArrayBuffer;
    await env.MAIL_STORE.put(key, content, { httpMetadata: { contentType: a.mimeType } });
    statements.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO attachments(id,mailbox_id,message_id,filename,content_type,size,object_key,content_id) VALUES(?,?,?,?,?,?,?,?)',
      ).bind(
        aid,
        box.id,
        id,
        a.filename || 'attachment',
        a.mimeType,
        content.byteLength,
        key,
        a.contentId || null,
      ),
    );
  }
  await env.DB.batch(statements);
  await audit(env, 'email-worker', 'mail.received', box.id, { messageId: id });
}
