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
import { api, provision } from './cloudflare';
import {
  getMessage,
  listMessages,
  patchMessage,
  present,
  receiveEmail,
  sendMail,
  sendSchema,
} from './mail';
import { handleMcp } from './mcp';
import { configuredEnv, saveToken } from './settings';

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
  c.set('principal', await dashboardAuth(c.req.raw, c.env));
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
app.get('/api/bootstrap', async (c) => {
  const [boxes, domains, drafts, counts] = await Promise.all([
    c.env.DB.prepare(
      "SELECT b.*, (SELECT COUNT(*) FROM messages m WHERE m.mailbox_id=b.id AND m.folder='inbox' AND m.is_read=0) AS unread FROM mailboxes b ORDER BY b.created_at",
    ).all(),
    c.env.DB.prepare('SELECT * FROM domains ORDER BY receiving DESC,name').all(),
    c.env.DB.prepare(
      'SELECT id,mailbox_id,data,updated_at FROM drafts ORDER BY updated_at DESC',
    ).all(),
    c.env.DB.prepare(
      'SELECT folder,COUNT(*) AS count,SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END) AS unread FROM messages GROUP BY folder',
    ).all(),
  ]);
  return c.json({
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
  return c.json(await provision(await configuredEnv(c.env), c.get('principal').actor, input), 201);
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
  await c.env.DB.prepare(
    'INSERT INTO attachments(id,mailbox_id,filename,content_type,size,object_key) VALUES(?,?,?,?,?,?)',
  )
    .bind(id, boxId, filename, type, bytes.length, key)
    .run();
  return c.json({ id, filename, size: bytes.length, content_type: type }, 201);
});
app.get('/api/attachments/:id', async (c) => {
  const a = await c.env.DB.prepare('SELECT * FROM attachments WHERE id=?')
    .bind(c.req.param('id'))
    .first<Attachment>();
  if (!a) throw new AppError(404, 'Attachment not found');
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
  await mailbox(c.env, draft.mailboxId);
  await c.env.DB.prepare(
    'INSERT INTO drafts(id,mailbox_id,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET mailbox_id=excluded.mailbox_id,data=excluded.data,updated_at=excluded.updated_at',
  )
    .bind(id, draft.mailboxId, JSON.stringify(draft.data), now())
    .run();
  return c.json({ id });
});
app.delete('/api/drafts/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM drafts WHERE id=?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
app.get('/api/tokens', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT t.id,t.mailbox_id,t.name,t.prefix,t.scopes,t.expires_at,t.revoked_at,t.last_used_at,t.created_at,b.address FROM agent_tokens t JOIN mailboxes b ON b.id=t.mailbox_id ORDER BY t.created_at DESC',
  ).all();
  return c.json({
    tokens: rows.results.map((t) => ({ ...t, scopes: JSON.parse(t.scopes as string) })),
  });
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
  await c.env.DB.prepare('UPDATE agent_tokens SET revoked_at=? WHERE id=?')
    .bind(now(), c.req.param('id'))
    .run();
  await audit(c.env, c.get('principal').actor, 'token.revoked', undefined, {
    tokenId: c.req.param('id'),
  });
  return c.json({ ok: true });
});
app.get('/api/stats', async (c) => {
  const [totals, days, boxes, storage, tokens, activity] = await Promise.all([
    c.env.DB.prepare(
      "SELECT COUNT(*) AS total,COALESCE(SUM(direction='inbound'),0) AS received,COALESCE(SUM(direction='outbound' AND status='accepted'),0) AS sent,COALESCE(SUM(is_read=0 AND folder='inbox'),0) AS unread,COALESCE(SUM(status='failed'),0) AS failed,COALESCE(SUM(size),0) AS message_bytes FROM messages",
    ).first(),
    c.env.DB.prepare(
      "SELECT substr(created_at,1,10) AS date,SUM(direction='inbound') AS received,SUM(direction='outbound' AND status='accepted') AS sent FROM messages WHERE created_at>=? GROUP BY substr(created_at,1,10) ORDER BY date",
    )
      .bind(new Date(Date.now() - 30 * 86400000).toISOString())
      .all(),
    c.env.DB.prepare(
      "SELECT b.id,b.address,b.color,COUNT(m.id) AS total,COALESCE(SUM(m.direction='inbound'),0) AS received,COALESCE(SUM(m.status='accepted'),0) AS sent FROM mailboxes b LEFT JOIN messages m ON m.mailbox_id=b.id GROUP BY b.id",
    ).all(),
    c.env.DB.prepare(
      'SELECT COUNT(*) AS attachments,COALESCE(SUM(size),0) AS attachment_bytes FROM attachments',
    ).first(),
    c.env.DB.prepare(
      'SELECT COUNT(*) AS active FROM agent_tokens WHERE revoked_at IS NULL AND expires_at>?',
    )
      .bind(now())
      .first(),
    c.env.DB.prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 30').all(),
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
  const { token } = await json(c.req.raw, z.object({ token: z.string().min(20).max(200) }));
  await saveToken(c.env, token);
  await audit(c.env, c.get('principal').actor, 'settings.provisioning_connected');
  return c.json({ ok: true });
});
app.post('/api/domains/sync', async (c) => {
  const env = await configuredEnv(c.env);
  for (let page = 1; ; page++) {
    const zones = await api<{ id: string; name: string; account: { id: string } }[]>(
      env,
      `/zones?account.id=${env.ACCOUNT_ID}&per_page=50&page=${page}`,
    );
    for (const z of zones) {
      if (z.account.id !== env.ACCOUNT_ID) continue;
      const [routing, sending, mx] = await Promise.all([
        api<{ enabled: boolean }>(env, `/zones/${z.id}/email/routing`),
        api<{ name: string; enabled: boolean }[]>(env, `/zones/${z.id}/email/sending/subdomains`),
        api<{ content: string }[]>(env, `/zones/${z.id}/dns_records?type=MX&name=${z.name}`),
      ]);
      const ready =
        !!routing.enabled &&
        mx.length > 0 &&
        mx.every((x) => x.content.endsWith('.mx.cloudflare.net'));
      await env.DB.prepare(
        'INSERT INTO domains(id,name,receiving,sending,note) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET receiving=excluded.receiving,sending=excluded.sending,note=excluded.note',
      )
        .bind(
          z.id,
          z.name,
          +ready,
          +sending.some((x) => x.name === z.name && x.enabled),
          ready
            ? null
            : 'Existing mail routing is preserved. This domain is not available for new inboxes.',
        )
        .run();
    }
    if (zones.length < 50) break;
  }
  return c.json({ ok: true });
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
    try {
      return await handleMcp(request, env, ctx);
    } catch (error) {
      return Response.json(
        { error: error instanceof AppError ? error.message : 'MCP request failed' },
        {
          status: error instanceof AppError ? error.status : 500,
          headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer realm="Mail HQ"' },
        },
      );
    }
  }
  if (url.pathname.startsWith('/api/')) return app.fetch(request, env, ctx);
  return null;
}
export { receiveEmail };
export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) =>
    (await fetchApi(request, env, ctx)) || new Response('Not found', { status: 404 }),
  email: receiveEmail,
} satisfies ExportedHandler<Env>;
