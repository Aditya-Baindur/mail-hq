import { sendDomainEmail } from './personal-domains';
import PostalMime from 'postal-mime';
import { z } from 'zod';
import { AppError, audit, hash, limitedBody, mailbox, now, rateLimit, uid, type Attachment, type Env, type Mailbox, type Message } from './model';
import { b64, buildMime } from './mime';
import { messageSearchStatements } from './search';
import { discardInactiveMailboxWrites } from './storage';

export const folders = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash'] as const;
const folderSchema = z.enum(folders);
const flagSchema = z.array(z.enum(['\\Seen', '\\Flagged', '\\Answered', '\\Deleted', '\\Draft'])).max(5);
type Entry = { uid: number; mailbox_id: string; source_id: string; kind: 'message' | 'draft'; folder: string; flags: string; raw_key: string | null };
type Credential = { id: string; mailbox_id: string; address: string; name: string };

export function bridgeSettings(env: Env) {
  const smtpPort = Number(env.BRIDGE_SMTP_PORT || '465');
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new AppError(503, 'Invalid bridge SMTP port configuration');
  return { host: env.BRIDGE_HOST || null, imapPort: 993, smtpPort, configured: !!(env.BRIDGE_HOST && env.BRIDGE_API_SECRET) };
}

export async function createMailPassword(env: Env, actor: string, input: { mailboxId: string; name: string }) {
  if (!env.BRIDGE_HOST || !env.BRIDGE_API_SECRET) throw new AppError(503, 'The mail bridge is not configured.');
  const box = await mailbox(env, input.mailboxId);
  if (box.status !== 'active') throw new AppError(409, 'Choose an active mailbox');
  const password = 'mail_' + b64(crypto.getRandomValues(new Uint8Array(24))).replace(/\+/g, '-').replace(/\//g, '_');
  const id = uid();
  await env.DB.prepare('INSERT INTO mail_app_passwords(id,mailbox_id,name,password_hash,prefix) VALUES(?,?,?,?,?)')
    .bind(id, box.id, input.name, await hash(password), password.slice(0, 10)).run();
  await audit(env, actor, 'mail_app.created', box.id, { credentialId: id });
  return { id, password, address: box.address, ...bridgeSettings(env) };
}

async function authenticate(request: Request, env: Env): Promise<Credential> {
  const secret = request.headers.get('x-mailhq-bridge') || '';
  if (!env.BRIDGE_API_SECRET || await hash(secret) !== await hash(env.BRIDGE_API_SECRET))
    throw new AppError(401, 'Bridge authentication required');
  let username = '', password = '';
  try {
    const decoded = atob(request.headers.get('authorization')?.match(/^Basic (.+)$/)?.[1] || '');
    const colon = decoded.indexOf(':');
    username = decoded.slice(0, colon).trim().toLowerCase(); password = decoded.slice(colon + 1);
  } catch { /* Uniform authentication failure below. */ }
  if (!/^mail_[A-Za-z0-9_-]{32}$/.test(password)) throw new AppError(401, 'Invalid mail-app login');
  const row = await env.DB.prepare(`SELECT p.id,p.mailbox_id,m.address,m.name FROM mail_app_passwords p
    JOIN mailboxes m ON m.id=p.mailbox_id WHERE p.password_hash=? AND m.address=? AND p.revoked_at IS NULL AND m.status='active'`)
    .bind(await hash(password), username).first<Credential>();
  if (!row) throw new AppError(401, 'Invalid mail-app login');
  await rateLimit(env, `bridge:${row.id}`, 1800);
  await env.DB.prepare('UPDATE mail_app_passwords SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)')
    .bind(now(), row.id, new Date(Date.now() - 300000).toISOString()).run();
  return row;
}

async function entry(env: Env, boxId: string, id: number) {
  const e = await env.DB.prepare('SELECT * FROM imap_entries WHERE mailbox_id=? AND uid=?').bind(boxId, id).first<Entry>();
  if (!e) throw new AppError(404, 'Message no longer exists in this folder');
  return e;
}

async function rawEntry(env: Env, e: Entry): Promise<Uint8Array> {
  if (e.raw_key) {
    const object = await env.MAIL_STORE.get(e.raw_key);
    if (!object) throw new AppError(503, 'Message content is unavailable');
    return new Uint8Array(await object.arrayBuffer());
  }
  let raw: Uint8Array;
  if (e.kind === 'message') {
    const m = await env.DB.prepare('SELECT * FROM messages WHERE id=? AND mailbox_id=?').bind(e.source_id, e.mailbox_id).first<Message>();
    if (!m) throw new AppError(404, 'Message not found');
    if (m.status === 'sending') throw new AppError(409, 'Message is still being submitted');
    if (m.raw_key) {
      const object = await env.MAIL_STORE.get(m.raw_key);
      if (!object) throw new AppError(503, 'Message content is unavailable');
      raw = new Uint8Array(await object.arrayBuffer());
    } else {
      const body = await env.MAIL_STORE.get(m.body_key);
      if (!body) throw new AppError(503, 'Message content is unavailable');
      const files = await env.DB.prepare('SELECT * FROM attachments WHERE message_id=? AND mailbox_id=? ORDER BY id').bind(m.id, e.mailbox_id).all<Attachment>();
      raw = await buildMime(env, m, await body.json(), files.results);
    }
  } else {
    const draft = await env.DB.prepare('SELECT data,updated_at FROM drafts WHERE id=? AND mailbox_id=?').bind(e.source_id, e.mailbox_id).first<{ data: string; updated_at: string }>();
    if (!draft) throw new AppError(404, 'Draft not found');
    const box = await mailbox(env, e.mailbox_id);
    const d = JSON.parse(draft.data);
    const files: Attachment[] = [];
    for (const a of (d.attachments || []).slice(0, 32)) {
      const file = await env.DB.prepare('SELECT * FROM attachments WHERE id=? AND mailbox_id=?').bind(a.id, box.id).first<Attachment>();
      if (file) files.push(file);
    }
    const addresses = (s: unknown) => JSON.stringify(typeof s === 'string' ? s.split(',').map(x => x.trim()).filter(Boolean) : []);
    raw = await buildMime(env, { id: `${e.source_id}-${e.uid}`, mailbox_id: box.id, sender: box.address, sender_name: box.name,
      recipients: addresses(d.to), cc: addresses(d.cc), bcc: addresses(d.bcc), subject: d.subject || '',
      created_at: draft.updated_at, message_id: null, in_reply_to: null, refs: '' }, d, files);
  }
  const key = `imap/${e.mailbox_id}/${e.uid}.eml`;
  await env.MAIL_STORE.put(key, raw);
  if (await discardInactiveMailboxWrites(env, e.mailbox_id, [key]))
    throw new AppError(409, 'Mailbox is not active');
  await env.DB.prepare('UPDATE imap_entries SET raw_key=? WHERE mailbox_id=? AND uid=? AND raw_key IS NULL').bind(key, e.mailbox_id, e.uid).run();
  return raw;
}

export async function bridgeSnapshot(env: Env, boxId: string, folder: string) {
  const rows = await env.DB.prepare(`SELECT e.*, COALESCE(m.is_read,1) AS is_read,COALESCE(m.starred,0) AS starred,
    COALESCE(m.created_at,d.updated_at) AS date FROM imap_entries e
    LEFT JOIN messages m ON e.kind='message' AND m.id=e.source_id
    LEFT JOIN drafts d ON e.kind='draft' AND d.id=e.source_id
    WHERE e.mailbox_id=? AND e.folder=? AND (m.status IS NULL OR m.status<>'sending') ORDER BY e.uid`).bind(boxId, folder).all<Entry & { is_read: number; starred: number; date: string }>();
  const sequence = await env.DB.prepare("SELECT seq FROM sqlite_sequence WHERE name='imap_entries'").first<{ seq: number }>();
  return { uidValidity: 1, uidNext: (sequence?.seq || 0) + 1, messages: rows.results.map(e => ({ uid: e.uid, date: e.date,
    flags: [...new Set([...JSON.parse(e.flags).filter((f: string) => !['\\Seen','\\Flagged','\\Draft'].includes(f)),
      ...(e.is_read ? ['\\Seen'] : []), ...(e.starred ? ['\\Flagged'] : []), ...(e.kind === 'draft' ? ['\\Draft'] : [])])] })) };
}

const addresses = (items: { address?: string; group?: { address?: string }[] }[] | undefined): string[] =>
  (items || []).flatMap(a => a.group ? a.group.map(b => b.address || '').filter(Boolean) : a.address ? [a.address] : []);

async function mimeFingerprint(raw: Uint8Array) {
  const p = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  // Clients may re-encode MIME when saving Sent. Compare decoded content, not
  // Message-ID alone: a reused ID must never cause a different message to vanish.
  return hash(JSON.stringify({ from: p.from, to: p.to, cc: p.cc, bcc: p.bcc, replyTo: p.replyTo,
    date: p.date, subject: p.subject, inReplyTo: p.inReplyTo, references: p.references,
    text: p.text?.replace(/\r\n/g, '\n'), html: p.html?.replace(/\r\n/g, '\n'),
    attachments: await Promise.all(p.attachments.map(async a => ({ filename: a.filename, type: a.mimeType,
      contentId: a.contentId, content: await hash(b64(new Uint8Array(a.content as ArrayBuffer))) }))) }));
}

async function persistMime(env: Env, box: Mailbox, raw: Uint8Array, folder: string, flags: string[], date: string, opts: { dedupe?: string; sending?: boolean } = {}) {
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  const id = uid(), prefix = `mail/${box.id}/${id}`, rawKey = `${prefix}/original.eml`, bodyKey = `${prefix}/body.json`;
  await env.MAIL_STORE.put(rawKey, raw);
  await env.MAIL_STORE.put(bodyKey, JSON.stringify({ text: parsed.text || '', html: parsed.html || '' }));
  const statements = [], files: Attachment[] = [];
  for (const a of parsed.attachments) {
    const aid = uid(), key = `${prefix}/attachments/${aid}`, content = a.content as ArrayBuffer;
    await env.MAIL_STORE.put(key, content);
    const file = { id: aid, mailbox_id: box.id, message_id: folder === 'drafts' ? null : id, filename: a.filename || 'attachment', content_type: a.mimeType, size: content.byteLength, object_key: key, content_id: a.contentId || null };
    files.push(file);
    statements.push(env.DB.prepare('INSERT INTO attachments(id,mailbox_id,message_id,filename,content_type,size,object_key,content_id) VALUES(?,?,?,?,?,?,?,?)')
      .bind(aid, box.id, file.message_id, file.filename, file.content_type, file.size, key, file.content_id));
  }
  if (folder === 'drafts') {
    statements.unshift(env.DB.prepare('INSERT INTO drafts(id,mailbox_id,data,updated_at) VALUES(?,?,?,?)').bind(id, box.id, JSON.stringify({ mailboxId: box.id,
      to: addresses(parsed.to).join(', '), cc: addresses(parsed.cc).join(', '), bcc: addresses(parsed.bcc).join(', '), subject: parsed.subject || '', text: parsed.text || '', html: parsed.html || '', attachments: files, idempotencyKey: uid() }), date));
  } else {
    statements.unshift(env.DB.prepare(`INSERT INTO messages(id,mailbox_id,thread_id,direction,folder,sender,sender_name,recipients,cc,bcc,reply_to,subject,snippet,body_key,raw_key,message_id,in_reply_to,refs,dedupe_key,is_read,starred,status,size,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, box.id, id, folder === 'sent' ? 'outbound' : 'inbound', folder,
      parsed.from?.address || box.address, parsed.from?.name || '', JSON.stringify(addresses(parsed.to)), JSON.stringify(addresses(parsed.cc)), JSON.stringify(addresses(parsed.bcc)),
      addresses(parsed.replyTo)[0] || null, parsed.subject || '', (parsed.text || '').slice(0,200), bodyKey, rawKey, parsed.messageId || null, parsed.inReplyTo || null, parsed.references || '',
      opts.dedupe || null, flags.includes('\\Seen') ? 1 : 0, flags.includes('\\Flagged') ? 1 : 0, opts.sending ? 'sending' : folder === 'sent' ? 'accepted' : 'received', raw.length, date));
    statements.push(...messageSearchStatements(env, id, bodyKey, { text: parsed.text, html: parsed.html }));
  }
  statements.push(env.DB.prepare('UPDATE imap_entries SET flags=?,raw_key=? WHERE mailbox_id=? AND source_id=?').bind(JSON.stringify(flags), rawKey, box.id, id));
  if (opts.sending) statements.push(env.DB.prepare('INSERT INTO imap_submissions(dedupe_key,mailbox_id,source_id,client_message_id) VALUES(?,?,?,?)').bind(opts.dedupe!, box.id, id, parsed.messageId || null));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (await discardInactiveMailboxWrites(env, box.id, [rawKey, bodyKey, ...files.map(file => file.object_key)]))
      throw new AppError(409, 'Mailbox is not active');
    throw error;
  }
  const e = await env.DB.prepare('SELECT uid FROM imap_entries WHERE mailbox_id=? AND source_id=?').bind(box.id, id).first<{ uid: number }>();
  return { id, uid: e!.uid, parsed, files };
}

async function submit(env: Env, cred: Credential, raw: Uint8Array, recipients: string[]) {
  const box = await mailbox(env, cred.mailbox_id);
  const domain = await env.DB.prepare('SELECT sending FROM domains WHERE id=?').bind(box.domain_id).first<{ sending: number }>();
  if (!domain?.sending) throw new AppError(409, 'Sending is not enabled for this mailbox');
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  if (parsed.from?.address?.toLowerCase() !== box.address.toLowerCase()) throw new AppError(403, 'From must match the authenticated mailbox');
  const dedupe = await hash(box.id + ':' + b64(raw) + ':' + [...recipients].sort().join(','));
  const prior = await env.DB.prepare('SELECT id,status FROM messages WHERE mailbox_id=? AND dedupe_key=?').bind(box.id, dedupe).first<{ id: string; status: string }>();
  if (prior) {
    if (prior.status === 'accepted') return prior;
    throw new AppError(409, 'This submission was already attempted. Check Mail HQ before resending.');
  }
  await rateLimit(env, `send:${box.id}`, 30);
  const saved = await persistMime(env, box, raw, 'sent', ['\\Seen'], now(), { dedupe, sending: true });
  const allowed = new Set(recipients.map(a => a.toLowerCase()));
  const to = addresses(parsed.to).filter(a => allowed.has(a.toLowerCase()));
  const cc = addresses(parsed.cc).filter(a => allowed.has(a.toLowerCase()) && !to.includes(a));
  const visible = new Set([...to, ...cc].map(a => a.toLowerCase()));
  const bcc = recipients.filter(a => !visible.has(a.toLowerCase()));
  const headers: Record<string,string> = {};
  for (const [key,value] of [['In-Reply-To', parsed.inReplyTo], ['References', parsed.references]]) if (value) headers[key!] = value;
  let accepted = false;
  try {
    await sendDomainEmail(env, box.domain_id, { from: { email: box.address, name: parsed.from.name || box.name }, to, cc, bcc,
      subject: parsed.subject || '(no subject)', text: parsed.text || '', html: parsed.html,
      replyTo: addresses(parsed.replyTo)[0], headers,
      attachments: parsed.attachments.map(a => a.contentId ? { filename: a.filename || 'attachment', type: a.mimeType, content: a.content as ArrayBuffer,
        disposition: 'inline' as const, contentId: a.contentId.replace(/[<>]/g,'') } : { filename: a.filename || 'attachment', type: a.mimeType, content: a.content as ArrayBuffer, disposition: 'attachment' as const }) });
    accepted = true;
    await env.DB.prepare("UPDATE messages SET status='accepted',bcc=? WHERE id=?").bind(JSON.stringify(bcc), saved.id).run();
  } catch (error) {
    const definitive = !accepted && typeof error === 'object' && error !== null && 'code' in error && String(error.code).startsWith('E_');
    await env.DB.prepare('UPDATE messages SET status=?,error=? WHERE id=?').bind(definitive ? 'failed' : 'uncertain', 'SMTP submission failed or could not be confirmed. Check delivery before retrying.', saved.id).run();
    throw new AppError(definitive ? 422 : 409, 'Submission could not be confirmed. Check Mail HQ before resending.');
  }
  // Audit must not turn a successfully accepted submission into an SMTP failure.
  await audit(env, `mail-app:${cred.id}`, 'mail.sent', box.id, { messageId: saved.id }).catch(() => {});
  return { id: saved.id, status: 'accepted' };
}

const operation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('login') }),
  z.object({ action: z.literal('snapshot'), folder: folderSchema }),
  z.object({ action: z.literal('raw'), uid: z.number().int().positive() }),
  z.object({ action: z.literal('flags'), uids: z.array(z.number().int().positive()).max(500), operation: z.enum(['set', 'add', 'remove']), flags: flagSchema }),
  z.object({ action: z.literal('transfer'), uids: z.array(z.number().int().positive()).max(500), folder: folderSchema, move: z.boolean() }),
  z.object({ action: z.literal('expunge'), uids: z.array(z.number().int().positive()).max(500) }),
  z.object({ action: z.literal('append'), folder: folderSchema, raw: z.string(), flags: flagSchema, date: z.string().datetime() }),
  z.object({ action: z.literal('submit'), raw: z.string(), recipients: z.array(z.string().email().max(254)).min(1).max(50) }),
]);

export async function handleBridge(request: Request, env: Env) {
  try {
    if (request.method !== 'POST') throw new AppError(405, 'POST required');
    const cred = await authenticate(request, env);
    const op = operation.parse(JSON.parse(new TextDecoder().decode(await limitedBody(request, 36 * 1024 * 1024))));
    let result: unknown = { ok: true };
    if (op.action === 'login') result = { address: cred.address, name: cred.name };
    else if (op.action === 'snapshot') result = await bridgeSnapshot(env, cred.mailbox_id, op.folder);
    else if (op.action === 'raw') result = { raw: b64(await rawEntry(env, await entry(env, cred.mailbox_id, op.uid))) };
    else if (op.action === 'append' || op.action === 'submit') {
      const raw = new Uint8Array(Buffer.from(op.raw, 'base64'));
      if (raw.length > (op.action === 'submit' ? 5 : 25) * 1024 * 1024) throw new AppError(413, 'Message is too large');
      if (op.action === 'submit') result = await submit(env, cred, raw, [...new Set(op.recipients)]);
      else {
        let reconciled = false;
        if (op.folder === 'sent') {
          const parsed = await PostalMime.parse(raw);
          if (parsed.messageId) {
            const candidates = await env.DB.prepare(`SELECT s.dedupe_key,m.raw_key FROM imap_submissions s JOIN messages m ON m.id=s.source_id
              WHERE s.mailbox_id=? AND s.client_message_id=? AND s.reconciled=0 AND m.status='accepted' AND s.created_at>? ORDER BY s.created_at DESC LIMIT 10`)
              .bind(cred.mailbox_id, parsed.messageId, new Date(Date.now()-86400000).toISOString()).all<{ dedupe_key: string; raw_key: string }>();
            if (candidates.results.length) {
              const fingerprint = await mimeFingerprint(raw);
              for (const candidate of candidates.results) {
                const original = await env.MAIL_STORE.get(candidate.raw_key);
                if (!original || await mimeFingerprint(new Uint8Array(await original.arrayBuffer())) !== fingerprint) continue;
                const receipt = await env.DB.prepare('UPDATE imap_submissions SET reconciled=1 WHERE dedupe_key=? AND mailbox_id=? AND reconciled=0 RETURNING source_id')
                  .bind(candidate.dedupe_key, cred.mailbox_id).first<{ source_id: string }>();
                if (receipt) { reconciled = true; result = { id: receipt.source_id, reconciled: true }; break; }
              }
            }
          }
        }
        if (!reconciled) {
          const saved = await persistMime(env, await mailbox(env, cred.mailbox_id), raw, op.folder, op.flags, op.date);
          result = { id: saved.id, uid: saved.uid };
        }
      }
    } else {
      // Resolve every UID against the authenticated mailbox before any mutation.
      const entries = await Promise.all([...new Set(op.uids)].map(id => entry(env, cred.mailbox_id, id)));
      if (op.action === 'flags') {
        const statements = [];
        for (const e of entries) {
          const current = new Set<string>(JSON.parse(e.flags));
          const m = e.kind === 'message' ? await env.DB.prepare('SELECT is_read,starred FROM messages WHERE id=?').bind(e.source_id).first<{ is_read: number; starred: number }>() : null;
          for (const [flag,on] of [['\\Seen', m ? m.is_read : 1], ['\\Flagged', m?.starred || 0]] as const) on ? current.add(flag) : current.delete(flag);
          const flags = op.operation === 'set' ? new Set(op.flags) : current;
          if (op.operation !== 'set') for (const f of op.flags) op.operation === 'add' ? flags.add(f) : flags.delete(f);
          statements.push(env.DB.prepare('UPDATE imap_entries SET flags=? WHERE uid=? AND mailbox_id=?').bind(JSON.stringify([...flags]), e.uid, cred.mailbox_id));
          if (e.kind === 'message') statements.push(env.DB.prepare('UPDATE messages SET is_read=CASE WHEN ? THEN ? ELSE is_read END,starred=CASE WHEN ? THEN ? ELSE starred END WHERE id=? AND mailbox_id=?')
            .bind(op.operation === 'set' || op.flags.includes('\\Seen') ? 1 : 0, flags.has('\\Seen') ? 1 : 0,
              op.operation === 'set' || op.flags.includes('\\Flagged') ? 1 : 0, flags.has('\\Flagged') ? 1 : 0, e.source_id, cred.mailbox_id));
        }
        if (statements.length) await env.DB.batch(statements);
      } else if (op.action === 'expunge') {
        const statements = [];
        for (const e of entries) {
          if (!JSON.parse(e.flags).includes('\\Deleted')) continue;
          if (e.kind === 'draft') statements.push(env.DB.prepare('DELETE FROM drafts WHERE id=? AND mailbox_id=?').bind(e.source_id, cred.mailbox_id));
          else if (e.folder !== 'trash') statements.push(env.DB.prepare("UPDATE messages SET folder='trash' WHERE id=? AND mailbox_id=?").bind(e.source_id, cred.mailbox_id));
          // Expunging Trash hides its IMAP entry; the dashboard retains a recoverable copy.
          else statements.push(env.DB.prepare('DELETE FROM imap_entries WHERE uid=? AND mailbox_id=?').bind(e.uid, cred.mailbox_id));
        }
        if (statements.length) await env.DB.batch(statements);
      } else if (op.action === 'transfer') {
        for (const e of entries) {
          if (op.move && e.folder === op.folder) continue;
          if (op.move && e.kind === 'message' && op.folder !== 'drafts') {
            await env.DB.batch([
              env.DB.prepare('UPDATE messages SET folder=? WHERE id=? AND mailbox_id=?').bind(op.folder, e.source_id, cred.mailbox_id),
              env.DB.prepare('UPDATE imap_entries SET flags=? WHERE source_id=? AND mailbox_id=? AND kind=\'message\'')
                .bind(JSON.stringify(JSON.parse(e.flags).filter((f: string) => f !== '\\Deleted')), e.source_id, cred.mailbox_id),
            ]);
          } else {
            const raw = await rawEntry(env, e);
            const snapshot = await bridgeSnapshot(env, cred.mailbox_id, e.folder);
            const metadata = snapshot.messages.find(m => m.uid === e.uid)!;
            await persistMime(env, await mailbox(env, cred.mailbox_id), raw, op.folder, metadata.flags.filter(f => f !== '\\Deleted'), metadata.date);
            if (op.move) {
              if (e.kind === 'draft') await env.DB.prepare('DELETE FROM drafts WHERE id=? AND mailbox_id=?').bind(e.source_id, cred.mailbox_id).run();
              else await env.DB.prepare("UPDATE messages SET folder='trash' WHERE id=? AND mailbox_id=?").bind(e.source_id, cred.mailbox_id).run();
            }
          }
        }
      }
    }
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AppError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500;
    if (status === 500) console.error('bridge.request.failed', error instanceof Error ? error.message : 'unknown');
    return Response.json({ error: error instanceof AppError ? error.message : status === 400 ? 'Invalid bridge request' : 'Bridge operation failed' }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
