import { connectDomain, connectDomainSchema, domainEnv, receiveRelay } from './personal-domains';
import { accountPrincipal, ownedResource, requireAdmin } from './accounts';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  AppError,
  audit,
  hash,
  limitedBody,
  mailbox,
  now,
  scope,
  uid,
  type Env,
  type Principal,
  type Message,
  type Attachment,
} from './model';
import { agentAuth, checkOrigin, dashboardAuth } from './auth';
import { provision } from './cloudflare';
import { deleteMailbox } from './mailboxes';
import { discardInactiveMailboxWrites } from './storage';
import { syncDomains } from './domains';
import {
  getMessage,
  listMessages,
  patchMessage,
  present,
  receiveEmail,
  sendMail,
  sendSchema,
} from './mail';
import { handleOAuth, listOAuthConnections, revokeOAuthConnection } from './oauth';
import { saveToken } from './settings';
import { bridgeSettings, createMailPassword, handleBridge } from './bridge';
import { mailAppProfile } from './mail-profile';

const app = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();
app.onError((error, c) => {
  const status = error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500;
  const message =
    error instanceof z.ZodError
      ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      : status === 500
        ? 'Something went wrong. Please try again.'
        : error.message;
  if (status === 500)
    console.error(
      JSON.stringify({ event: 'request.failed', path: c.req.path, error: error.message }),
    );
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
});
app.use('/api/*', async (c, next) => {
  c.set('principal', await accountPrincipal(c.env, await dashboardAuth(c.req.raw, c.env)));
  checkOrigin(c.req.raw, c.env);
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
});
const json = async <T extends z.ZodType>(request: Request, schema: T) => {
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(await limitedBody(request))));
  } catch (e) {
    if (e instanceof SyntaxError) throw new AppError(400, 'Invalid JSON');
    throw e;
  }
};
app.delete('/api/mailboxes/:id', async (c) => {
  const id = z.string().uuid().parse(c.req.param('id'));
  const input = await json(c.req.raw, z.object({ address: z.string().trim().email().max(254) }));
  await scope(c.env, c.get('principal'), id);
  return c.json(await deleteMailbox(c.env, c.get('principal').actor, id, input.address));
});
app.get('/api/bootstrap', async (c) => {
  const owner = c.get('principal').userId!;
  const [boxes, domains, drafts, counts] = await Promise.all([
    c.env.DB.prepare(
      "SELECT b.*, (SELECT COUNT(*) FROM messages m WHERE m.mailbox_id=b.id AND m.folder='inbox' AND m.is_read=0) AS unread FROM mailboxes b WHERE b.owner_id=? ORDER BY b.created_at",
    ).bind(owner).all(),
    c.env.DB.prepare('SELECT d.*,c.ready AS connection_ready FROM domains d LEFT JOIN domain_connections c ON c.domain_id=d.id WHERE d.owner_id=? ORDER BY d.receiving DESC,d.name').bind(owner).all(),
    c.env.DB.prepare(
      'SELECT id,mailbox_id,data,updated_at FROM drafts WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE owner_id=?) ORDER BY updated_at DESC',
    ).bind(owner).all(),
    c.env.DB.prepare(
      `SELECT mailbox_id,folder,COUNT(*) AS count,SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END) AS unread FROM messages WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE owner_id=?) GROUP BY mailbox_id,folder
       UNION ALL SELECT mailbox_id,'starred' AS folder,COUNT(*) AS count,SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END) AS unread FROM messages WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE owner_id=?) AND starred=1 AND folder NOT IN ('trash','spam') GROUP BY mailbox_id`,
    ).bind(owner, owner).all(),
  ]);
  return c.json({
    isAdmin: !!c.get('principal').isAdmin,
    ownerConfigured: !!c.env.OWNER_EMAIL || c.env.LOCAL_DEV === 'true',
    mailboxes: boxes.results,
    domains: domains.results,
    drafts: drafts.results.map((d) => ({ ...d, data: JSON.parse(d.data as string) })),
    counts: counts.results,
    identity: c.get('principal').actor,
    managedProvisioning: domains.results.some((d) => d.routing_mode === 'managed'),
    provisioningConfigured:
      !!c.env.CF_API_TOKEN || !!(await c.env.MAIL_STORE.head('system/provisioning-token')),
    mcpUrl: `https://${c.env.MCP_HOST}/mcp`,
    appOrigin: c.env.APP_ORIGIN,
  });
});
app.post('/api/mailboxes', async (c) => {
  const input = await json(
    c.req.raw,
    z.object({
      localPart: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*$/),
      domainId: z.string().length(32),
      name: z.string().trim().max(100).default(''),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default('#647c68'),
    }),
  );
  const domain = await c.env.DB.prepare('SELECT id FROM domains WHERE id=? AND owner_id=?').bind(input.domainId, c.get('principal').userId!).first();
  if (!domain) throw new AppError(404, 'Domain not found');
  return c.json(await provision(await domainEnv(c.env, input.domainId), c.get('principal').actor, input, c.get('principal').userId!), 201);
});
app.get('/api/messages', async (c) =>
  c.json(
    await listMessages(c.env, c.get('principal'), {
      mailboxId: c.req.query('mailboxId'),
      folder: c.req.query('folder'),
      q: c.req.query('q'),
      cursor: c.req.query('cursor'),
      unread: c.req.query('unread') === 'true',
      starred: c.req.query('starred') === 'true',
    }),
  ),
);
app.get('/api/messages/:id', async (c) =>
  c.json(await getMessage(c.env, c.get('principal'), c.req.param('id'))),
);
app.get('/api/messages/:id/thread', async (c) => {
  const m = await c.env.DB.prepare('SELECT * FROM messages WHERE id=?')
    .bind(c.req.param('id'))
    .first<Message>();
  if (!m) throw new AppError(404, 'Message not found');
  await scope(c.env, c.get('principal'), m.mailbox_id);
  const rows = await c.env.DB.prepare(
    'SELECT * FROM messages WHERE mailbox_id=? AND thread_id=? ORDER BY created_at',
  )
    .bind(m.mailbox_id, m.thread_id)
    .all<Message>();
  return c.json({ messages: rows.results.map(present) });
});
app.patch('/api/messages/:id', async (c) =>
  c.json(
    await patchMessage(
      c.env,
      c.get('principal'),
      c.req.param('id'),
      await json(
        c.req.raw,
        z.object({
          isRead: z.boolean().optional(),
          starred: z.boolean().optional(),
          folder: z.enum(['inbox', 'sent', 'archive', 'trash', 'spam']).optional(),
        }),
      ),
    ),
  ),
);
app.post('/api/send', async (c) =>
  c.json(await sendMail(c.env, c.get('principal'), await json(c.req.raw, sendSchema))),
);
app.get('/api/messages/:id/raw', async (c) => {
  const m = await c.env.DB.prepare('SELECT * FROM messages WHERE id=?')
    .bind(c.req.param('id'))
    .first<Message>();
  if (!m?.raw_key) throw new AppError(404, 'Original message is unavailable');
  await scope(c.env, c.get('principal'), m.mailbox_id);
  const object = await c.env.MAIL_STORE.get(m.raw_key);
  if (!object) throw new AppError(404, 'Original message is unavailable');
  return new Response(object.body, {
    headers: {
      'Content-Type': 'message/rfc822',
      'Content-Disposition': 'attachment; filename="message.eml"',
      'Cache-Control': 'no-store',
    },
  });
});
app.post('/api/attachments', async (c) => {
  const boxId = c.req.query('mailboxId') || '';
  await scope(c.env, c.get('principal'), boxId, 'send');
  const b = await mailbox(c.env, boxId);
  if (b.status !== 'active') throw new AppError(409, 'Mailbox is not active');
  const bytes = await limitedBody(c.req.raw, 3 * 1024 * 1024);
  if (!bytes.length) throw new AppError(400, 'Empty attachment');
  const filename = (
    c.req.header('x-filename') ? decodeURIComponent(c.req.header('x-filename')!) : 'attachment'
  )
    .replace(/[\r\n/\\]/g, '_')
    .slice(0, 200);
  const type = c.req.header('content-type') || 'application/octet-stream';
  const id = uid(),
    key = `uploads/${boxId}/${id}`;
  await c.env.MAIL_STORE.put(key, bytes, { httpMetadata: { contentType: type } });
  try {
    await c.env.DB.prepare(
      'INSERT INTO attachments(id,mailbox_id,filename,content_type,size,object_key) VALUES(?,?,?,?,?,?)',
    ).bind(id, boxId, filename, type, bytes.length, key).run();
  } catch (error) {
    if (await discardInactiveMailboxWrites(c.env, boxId, [key]))
      throw new AppError(409, 'Mailbox is not active');
    throw error;
  }
  return c.json({ id, filename, size: bytes.length, content_type: type }, 201);
});
app.get('/api/attachments/:id', async (c) => {
  const a = await c.env.DB.prepare('SELECT * FROM attachments WHERE id=?')
    .bind(c.req.param('id'))
    .first<Attachment>();
  if (!a) throw new AppError(404, 'Attachment not found');
  await scope(c.env, c.get('principal'), a.mailbox_id);
  const object = await c.env.MAIL_STORE.get(a.object_key);
  if (!object) throw new AppError(404, 'Attachment not found');
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
});
app.put('/api/drafts/:id', async (c) => {
  const id = z.string().uuid().parse(c.req.param('id'));
  const draft = await json(
    c.req.raw,
    z.object({ mailboxId: z.string().uuid(), data: z.record(z.string(), z.unknown()) }),
  );
  await scope(c.env, c.get('principal'), draft.mailboxId, 'send');
  const existing = await c.env.DB.prepare('SELECT id FROM drafts WHERE id=?').bind(id).first();
  if (existing) await ownedResource(c.env, c.get('principal'), 'drafts', id);
  const box = await mailbox(c.env, draft.mailboxId);
  if (box.status !== 'active') throw new AppError(409, 'Mailbox is not active');
  await c.env.DB.prepare(
    'INSERT INTO drafts(id,mailbox_id,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET mailbox_id=excluded.mailbox_id,data=excluded.data,updated_at=excluded.updated_at WHERE drafts.mailbox_id IN (SELECT id FROM mailboxes WHERE owner_id=?)',
  )
    .bind(id, draft.mailboxId, JSON.stringify(draft.data), now(), c.get('principal').userId!)
    .run();
  return c.json({ id });
});
app.delete('/api/drafts/:id', async (c) => {
  await ownedResource(c.env, c.get('principal'), 'drafts', c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM drafts WHERE id=?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
app.get('/api/tokens', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT t.id,t.mailbox_id,t.name,t.prefix,t.scopes,t.expires_at,t.revoked_at,t.last_used_at,t.created_at,b.address FROM agent_tokens t JOIN mailboxes b ON b.id=t.mailbox_id WHERE b.owner_id=? ORDER BY t.created_at DESC',
  ).bind(c.get('principal').userId!).all();
  return c.json({
    tokens: rows.results.map((t) => ({ ...t, scopes: JSON.parse(t.scopes as string) })),
  });
});
app.get('/api/mail-apps', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT p.id,p.name,p.prefix,p.created_at,p.last_used_at,p.revoked_at,m.address
    FROM mail_app_passwords p JOIN mailboxes m ON m.id=p.mailbox_id WHERE m.owner_id=? ORDER BY p.created_at DESC`).bind(c.get('principal').userId!).all();
  return c.json({ connections: rows.results, ...bridgeSettings(c.env) });
});
app.get('/api/mail-apps/:id/apple.mobileconfig', async (c) => {
  const id = z.string().uuid().parse(c.req.param('id'));
  await ownedResource(c.env, c.get('principal'), 'mail_app_passwords', id);
  return mailAppProfile(c.env, id);
});
app.post('/api/mail-apps', async (c) => {
  const input = await json(c.req.raw, z.object({ mailboxId: z.string().uuid(), name: z.string().trim().min(1).max(100) }));
  await scope(c.env, c.get('principal'), input.mailboxId);
  return c.json(await createMailPassword(c.env, c.get('principal').actor, input), 201);
});
app.delete('/api/mail-apps/:id', async (c) => {
  const id = z.string().uuid().parse(c.req.param('id'));
  await ownedResource(c.env, c.get('principal'), 'mail_app_passwords', id);
  await c.env.DB.prepare('UPDATE mail_app_passwords SET revoked_at=? WHERE id=?').bind(now(), id).run();
  await audit(c.env, c.get('principal').actor, 'mail_app.revoked', undefined, { credentialId: id });
  return c.json({ ok: true });
});
app.get('/api/oauth/connections', async (c) =>
  c.json({ connections: await listOAuthConnections(c.env, c.get('principal').actor) }),
);
app.delete('/api/oauth/connections/:id', async (c) => {
  await revokeOAuthConnection(c.env, c.get('principal').actor, z.string().uuid().parse(c.req.param('id')));
  return c.json({ ok: true });
});
app.post('/api/tokens', async (c) => {
  const input = await json(
    c.req.raw,
    z.object({
      mailboxId: z.string().uuid(),
      name: z.string().trim().min(1).max(100),
      scopes: z.array(z.enum(['read', 'send'])).min(1),
      expiresInDays: z.number().int().min(1).max(365).default(90),
    }),
  );
  await scope(c.env, c.get('principal'), input.mailboxId);
  const b = await mailbox(c.env, input.mailboxId);
  if (b.status !== 'active') throw new AppError(409, 'Choose an active mailbox');
  const token =
    'mhq_' +
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  const id = uid(),
    expiresAt = new Date(Date.now() + input.expiresInDays * 86400000).toISOString();
  await c.env.DB.prepare(
    'INSERT INTO agent_tokens(id,mailbox_id,name,token_hash,prefix,scopes,expires_at) VALUES(?,?,?,?,?,?,?)',
  )
    .bind(
      id,
      input.mailboxId,
      input.name,
      await hash(token),
      token.slice(0, 12),
      JSON.stringify([...new Set(input.scopes)]),
      expiresAt,
    )
    .run();
  await audit(c.env, c.get('principal').actor, 'token.created', b.id, {
    tokenId: id,
    scopes: input.scopes,
  });
  return c.json({ id, token, expiresAt, url: `https://${c.env.MCP_HOST}/mcp` }, 201);
});
app.delete('/api/tokens/:id', async (c) => {
  await ownedResource(c.env, c.get('principal'), 'agent_tokens', c.req.param('id'));
  await c.env.DB.prepare('UPDATE agent_tokens SET revoked_at=? WHERE id=?')
    .bind(now(), c.req.param('id'))
    .run();
  await audit(c.env, c.get('principal').actor, 'token.revoked', undefined, {
    tokenId: c.req.param('id'),
  });
  return c.json({ ok: true });
});
app.get('/api/stats', async (c) => {
  const owner = c.get('principal').userId!;
  const owned = (query: string, ...args: string[]) => c.env.DB.prepare(`WITH
    owned_boxes AS (SELECT * FROM main.mailboxes WHERE owner_id=?),
    mailboxes AS (SELECT * FROM owned_boxes),
    messages AS (SELECT * FROM main.messages WHERE mailbox_id IN (SELECT id FROM owned_boxes)),
    attachments AS (SELECT * FROM main.attachments WHERE mailbox_id IN (SELECT id FROM owned_boxes)),
    agent_tokens AS (SELECT * FROM main.agent_tokens WHERE mailbox_id IN (SELECT id FROM owned_boxes)),
    oauth_connections AS (SELECT * FROM main.oauth_connections WHERE mailbox_id IN (SELECT id FROM owned_boxes)),
    audit_events AS (SELECT * FROM main.audit_events WHERE mailbox_id IN (SELECT id FROM owned_boxes) OR (mailbox_id IS NULL AND actor=?))
    ${query}`).bind(owner, c.get('principal').actor, ...args);
  const [totals, days, boxes, storage, tokens, activity] = await Promise.all([
    owned(
      "SELECT COUNT(*) AS total,COALESCE(SUM(direction='inbound'),0) AS received,COALESCE(SUM(direction='outbound' AND status='accepted'),0) AS sent,COALESCE(SUM(is_read=0 AND folder='inbox'),0) AS unread,COALESCE(SUM(status='failed'),0) AS failed,COALESCE(SUM(size),0) AS message_bytes FROM messages",
    ).first(),
    owned(
      "SELECT substr(created_at,1,10) AS date,SUM(direction='inbound') AS received,SUM(direction='outbound' AND status='accepted') AS sent FROM messages WHERE created_at>=? GROUP BY substr(created_at,1,10) ORDER BY date",
      new Date(Date.now() - 30 * 86400000).toISOString(),
    )
      .all(),
    owned(
      "SELECT b.id,b.address,b.color,COUNT(m.id) AS total,COALESCE(SUM(m.direction='inbound'),0) AS received,COALESCE(SUM(m.status='accepted'),0) AS sent FROM mailboxes b LEFT JOIN messages m ON m.mailbox_id=b.id GROUP BY b.id",
    ).all(),
    owned(
      'SELECT COUNT(*) AS attachments,COALESCE(SUM(size),0) AS attachment_bytes FROM attachments',
    ).first(),
    owned(
      `SELECT (SELECT COUNT(*) FROM agent_tokens WHERE revoked_at IS NULL AND expires_at>?) +
        (SELECT COUNT(*) FROM oauth_connections WHERE revoked_at IS NULL AND expires_at>?) AS active`,
      now(), now(),
    )
      .first(),
    owned('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 30').all(),
  ]);
  return c.json({
    totals,
    days: days.results,
    mailboxes: boxes.results,
    storage,
    tokens,
    activity: activity.results,
  });
});
app.post('/api/settings/cloudflare-token', async (c) => {
  requireAdmin(c.get('principal'));
  const { token } = await json(c.req.raw, z.object({ token: z.string().min(20).max(200) }));
  const result = await saveToken(c.env, token);
  await audit(c.env, c.get('principal').actor, 'settings.provisioning_connected');
  return c.json({ ok: true, ...result });
});
app.post('/api/domains/connect', async (c) => c.json(await connectDomain(c.env, c.get('principal'), await json(c.req.raw, connectDomainSchema))));
app.post('/api/domains/sync', async (c) => {
  requireAdmin(c.get('principal'));
  const result = await syncDomains(c.env);
  await accountPrincipal(c.env, c.get('principal'));
  return c.json(result);
});
export async function fetchApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const redirects = (env.REDIRECT_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  if (redirects.includes(url.hostname))
    return Response.redirect(`${env.APP_ORIGIN}${url.pathname}${url.search}`, 308);
  if (url.hostname === env.MCP_HOST) {
    if (url.pathname.startsWith('/inbound/')) return receiveRelay(request, env, url.pathname.slice('/inbound/'.length));
    if (url.pathname === '/bridge/v1') return handleBridge(request, env);
    return handleOAuth(request, env, ctx);
  }
  if (url.origin === env.APP_ORIGIN && url.pathname === '/oauth/authorize') return handleOAuth(request, env, ctx);
  if (url.pathname.startsWith('/api/')) return app.fetch(request, env, ctx);
  return null;
}
export { receiveEmail };
export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) =>
    (await fetchApi(request, env, ctx)) || new Response('Not found', { status: 404 }),
  email: receiveEmail,
} satisfies ExportedHandler<Env>;
