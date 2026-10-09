import { accountPrincipal } from './accounts';
import OAuthProvider, { AuthorizationError, CimdFetchError, getOAuthApi, OAuthError,
  type ConsentDescription, type OAuthHelpers, type OAuthProviderOptions, type OAuthResourceAuth } from '@cloudflare/workers-oauth-provider';
import { z } from 'zod';
import { checkOrigin, dashboardAuth } from './auth';
import { handleMcp } from './mcp';
import { AppError, audit, hash, limitedBody, mailbox, scope, now, rateLimit, uid, type Env, type Principal } from './model';

type OAuthProps = { connectionId: string };
type Connection = { id: string; user_id: string; client_id: string; mailbox_id: string; scopes: string;
  grant_id: string | null; revoked_at: string | null; expires_at: string; mailbox_status: string; owner_id: string | null };
const scopeMap = { 'mail:read': 'read', 'mail:send': 'send' } as const;
const lifetime = 30 * 86400;
const escape = (value: string) => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
export const oauthUserId = (actor: string) => hash(actor.toLowerCase());

async function connection(env: Env, id: unknown) {
  if (typeof id !== 'string' || !z.string().uuid().safeParse(id).success) return null;
  const row = await env.DB.prepare(`SELECT c.*,m.owner_id,m.status AS mailbox_status FROM oauth_connections c
    JOIN mailboxes m ON m.id=c.mailbox_id WHERE c.id=? AND c.revoked_at IS NULL AND c.expires_at>? AND m.status='active'`)
    .bind(id, now()).first<Connection>();
  if (!row?.owner_id || await oauthUserId(row.owner_id) !== row.user_id) return null;
  return row;
}

async function oauthPrincipal(env: Env, props: OAuthProps, auth: OAuthResourceAuth): Promise<Principal> {
  const row = await connection(env, props?.connectionId);
  if (!row || row.user_id !== auth.userId || row.client_id !== auth.clientId)
    throw new AppError(401, 'This connection has expired, was revoked, or its mailbox is inactive.');
  const permitted: string[] = JSON.parse(row.scopes);
  const scopes = Object.entries(scopeMap).filter(([oauth, permission]) => auth.scope.includes(oauth) && permitted.includes(permission)).map(([, permission]) => permission);
  if (!scopes.length) throw new AppError(403, 'This connection has no mailbox permissions.');
  await rateLimit(env, `mcp-oauth:${row.id}`, 120);
  await env.DB.prepare('UPDATE oauth_connections SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)')
    .bind(now(), row.id, new Date(Date.now() - 60000).toISOString()).run();
  return { actor: `oauth:${row.id}`, mailboxId: row.mailbox_id, scopes };
}

function options(env: Env): OAuthProviderOptions<Env> {
  const issuer = `https://${env.MCP_HOST}`, resource = `${issuer}/mcp`;
  return {
    apiRoute: resource,
    apiHandler: { async fetch(request, runtimeEnv, ctx) {
      const context = ctx as ExecutionContext<OAuthProps> & { auth: OAuthResourceAuth };
      try { return await handleMcp(request, runtimeEnv, ctx, await oauthPrincipal(runtimeEnv, context.props, context.auth)); }
      catch (e) { return oauthFailure(e, runtimeEnv); }
    } },
    defaultHandler: { fetch: (request, runtimeEnv) => authorize(request, runtimeEnv,
      (runtimeEnv as Env & { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER) },
    authorizeEndpoint: `${env.APP_ORIGIN}/oauth/authorize`,
    tokenEndpoint: `${issuer}/oauth/token`,
    clientRegistrationEndpoint: `${issuer}/oauth/register`,
    resourceMetadata: { resource, authorization_servers: [issuer], resource_name: 'MailHQ' },
    // get_mailbox works for any approved connection; individual tools enforce
    // read/send permissions rather than imposing a global read requirement.
    requiredScopes: [],
    scopesSupported: ['mail:read', 'mail:send', 'offline_access'],
    clientIdMetadataDocumentEnabled: true,
    // Cursor's native-app callback uses a private URI scheme; HTTPS and
    // loopback callbacks cover ChatGPT, Codex and browser-based clients.
    allowPrivateUseRedirectUris: true,
    accessTokenTTL: 3600,
    refreshTokenTTL: lifetime,
    clientRegistrationTTL: 90 * 86400,
    async tokenExchangeCallback(input) {
      const row = await connection(input.env, input.props?.connectionId);
      if (!row || row.user_id !== input.userId || row.client_id !== input.clientId)
        throw new OAuthError('invalid_grant', { description: 'MailHQ access has expired or was revoked. Connect again.' });
      await input.env.DB.prepare('UPDATE oauth_connections SET grant_id=? WHERE id=?')
        .bind(input.grantId, row.id).run();
    },
    // Do not log request objects, authorization codes, tokens or client assertions.
    onError: ({ code, internal }) => { if (code === 'server_error') console.error('oauth.failed', internal.category, internal.reason); },
  };
}

function oauthFailure(error: unknown, env: Env) {
  const status = error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500;
  if (status === 500) console.error('oauth.request.failed', error instanceof Error ? error.name : 'unknown');
  return Response.json({ error: error instanceof AppError ? error.message : status === 400 ? 'Invalid request' : 'OAuth is temporarily unavailable' }, {
    status, headers: { 'Cache-Control': 'no-store', ...(status === 401 ? {
      'WWW-Authenticate': `Bearer resource_metadata="https://${env.MCP_HOST}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
    } : {}) },
  });
}

export async function handleOAuth(request: Request, env: Env, ctx: ExecutionContext) {
  try {
    const url = new URL(request.url);
    const isMcp = url.hostname === env.MCP_HOST;
    if (!isMcp && !(url.origin === env.APP_ORIGIN && url.pathname === '/oauth/authorize')) return new Response('Not found', { status: 404 });
    if (isMcp && url.pathname === '/') { url.pathname = '/mcp'; request = new Request(url, request); }
    if (isMcp && url.pathname === '/mcp' && /^Bearer mhq_/.test(request.headers.get('authorization') || ''))
      return await handleMcp(request, env, ctx);
    if (isMcp && !['/mcp', '/oauth/token', '/oauth/register'].includes(url.pathname) && !url.pathname.startsWith('/.well-known/'))
      return new Response('Not found', { status: 404 });
    if (isMcp && !url.pathname.startsWith('/.well-known/')) {
      await rateLimit(env, `oauth-ip:${await hash(request.headers.get('cf-connecting-ip') || 'local')}:${url.pathname}`,
        url.pathname === '/oauth/register' ? 30 : 240);
    }
    if (request.method === 'POST' && url.pathname !== '/mcp') {
      const body = await limitedBody(request, 32 * 1024);
      request = new Request(request.url, { method: 'POST', headers: request.headers, body });
    }
    return await new OAuthProvider(options(env)).fetch(request, env, ctx);
  } catch (error) { return oauthFailure(error, env); }
}

function consentPage(details: ConsentDescription, handle: string, actor: string, boxes: { id: string; address: string }[]) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to MailHQ</title>
  <style>body{margin:0;background:#f5f4f0;color:#242723;font:15px/1.6 system-ui,sans-serif}main{max-width:480px;margin:6vh auto;padding:32px;background:#fff;border:1px solid #deded8;border-radius:16px}h1{font-size:26px;line-height:1.2}p{color:#586055;overflow-wrap:anywhere}label{display:block;margin:16px 0}select,button{font:inherit;padding:12px;border:1px solid #bdc4ba;border-radius:8px}select{display:block;width:100%;margin-top:8px}input{accent-color:#436345}button{cursor:pointer;background:#436345;color:white}button.secondary{background:white;color:#242723}footer{margin-top:28px;font-size:12px;color:#687364}@media(max-width:540px){main{margin:16px;padding:24px}}</style></head><body><main>
  <strong>MailHQ</strong><h1>Connect ${escape(details.clientName)}</h1>
  <p>${details.clientDomain ? `Client domain: <strong>${escape(details.clientDomain)}</strong>.` : 'This app registered its own name; its name is not verified.'}
  Access returns to <strong>${escape(details.redirectHost || 'the requesting application')}</strong>.</p>
  ${details.redirectIsLoopback ? '<p>This connects an app on your computer. Continue only if you just started connecting it.</p>' : ''}
  <form method="post" action="/oauth/authorize"><input type="hidden" name="handle" value="${escape(handle)}">
  <label>Mailbox<select name="mailboxId" required><option value="" disabled selected>Choose the exact email address</option>${boxes.map(b => `<option value="${escape(b.id)}">${escape(b.address)}</option>`).join('')}</select></label>
  <label><input type="checkbox" name="read" value="yes" checked> Read messages and attachments</label>
  <label><input type="checkbox" name="send" value="yes"> Send and reply from this mailbox</label>
  <p>This app can stay connected for up to 30 days. You can revoke access in MailHQ → Agents.</p>
  <button type="submit" name="decision" value="approve" ${boxes.length ? '' : 'disabled'}>Allow access</button>
  <button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Cancel</button></form>
  ${boxes.length ? '' : '<p>Create an active mailbox in MailHQ before connecting an app.</p>'}
  <footer>Signed in as ${escape(actor)}</footer></main></body></html>`;
}

async function claimConsent(env: Env, handle: string, userId: string) {
  const row = await env.DB.prepare('DELETE FROM oauth_consents WHERE handle_hash=? AND user_id=? AND expires_at>? RETURNING handle_hash')
    .bind(await hash(handle), userId, now()).first();
  if (!row) throw new AppError(400, 'This authorization page expired, was used, or belongs to another session. Start connecting again.');
}

async function authorize(request: Request, env: Env, oauth: OAuthHelpers) {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.pathname !== '/oauth/authorize') return new Response('Not found', { status: 404 });
  try {
    const principal = await accountPrincipal(env, await dashboardAuth(request, env));
    checkOrigin(request, env);
    const userId = await oauthUserId(principal.actor);
    await rateLimit(env, `oauth-consent:${userId}`, 30);
    if (request.method === 'GET') {
      const auth = await oauth.parseAuthRequest(request);
      if (auth.codeChallengeMethod !== 'S256' || !auth.codeChallenge) throw new AppError(400, 'This client must use PKCE with S256.');
      const details = await oauth.describeConsent(auth);
      const boxes = await env.DB.prepare("SELECT id,address FROM mailboxes WHERE status='active' AND owner_id=? ORDER BY address").bind(principal.userId!).all<{ id: string; address: string }>();
      const consent = await oauth.beginConsent(auth);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM oauth_consents WHERE expires_at<=?').bind(now()),
        env.DB.prepare('INSERT INTO oauth_consents(handle_hash,user_id,expires_at) VALUES(?,?,?)')
          .bind(await hash(consent.handle), userId, new Date(Date.now() + 600000).toISOString()),
      ]);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      // no-referrer makes browsers send Origin: null on native form POSTs,
      // so our same-origin CSRF check would reject the user's Allow/Cancel.
      // Keep the origin for this form; callbacks still use no-referrer.
      consent.headers.set('Referrer-Policy', 'same-origin');
      consent.headers.set('X-Content-Type-Options', 'nosniff');
      // Browsers can apply form-action to redirects, including the client's
      // loopback/native callback. Allow only this already-validated destination.
      const redirect = new URL(details.redirectUri);
      const callbackSource = ['https:', 'http:'].includes(redirect.protocol) ? redirect.origin : redirect.protocol;
      consent.headers.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackSource}; frame-ancestors 'none'; base-uri 'none'`);
      return new Response(consentPage(details, consent.handle, principal.actor, boxes.results), { headers: consent.headers });
    }
    if (request.method !== 'POST') throw new AppError(405, 'Use GET or POST');
    if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new AppError(400, 'Invalid authorization form');
    const form = new URLSearchParams(await request.text());
    const handle = z.string().min(20).max(512).parse(form.get('handle'));
    if (form.get('decision') === 'deny') {
      const denied = await oauth.denyConsent(request, handle);
      await claimConsent(env, handle, userId);
      denied.headers.set('Referrer-Policy', 'no-referrer');
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (form.get('decision') !== 'approve') throw new AppError(400, 'Choose whether to allow access');
    const box = await mailbox(env, z.string().uuid().parse(form.get('mailboxId')));
    await scope(env, principal, box.id);
    if (box.status !== 'active') throw new AppError(409, 'Choose an active mailbox');
    const scopes: ('read' | 'send')[] = [];
    if (form.get('read') === 'yes') scopes.push('read');
    if (form.get('send') === 'yes') scopes.push('send');
    if (!scopes.length) throw new AppError(400, 'Select at least one permission');
    const approved = await oauth.approveConsent(request, handle, { scope: [...scopes.map(s => `mail:${s}`), 'offline_access'] });
    await claimConsent(env, handle, userId);
    const client = await oauth.lookupClient(approved.request.clientId);
    const id = uid();
    await env.DB.prepare('INSERT INTO oauth_connections(id,user_id,client_id,name,mailbox_id,scopes,expires_at) VALUES(?,?,?,?,?,?,?)')
      .bind(id, userId, approved.request.clientId, (client?.clientName || 'MCP client').slice(0, 200), box.id, JSON.stringify(scopes), new Date(Date.now() + lifetime * 1000).toISOString()).run();
    let redirectTo: string;
    try {
      ({ redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId,
        metadata: { connectionId: id, mailboxId: box.id }, props: { connectionId: id }, scope: approved.request.scope,
        // Each approval picks a mailbox. Connecting another must not revoke an
        // already-approved mailbox for the same client (or another device).
        revokeExistingGrants: false }));
    } catch (error) {
      await env.DB.prepare('UPDATE oauth_connections SET revoked_at=? WHERE id=?').bind(now(), id).run();
      throw error;
    }
    await audit(env, principal.actor, 'oauth.authorized', box.id, { connectionId: id }).catch(() => {});
    approved.headers.set('Location', redirectTo);
    approved.headers.set('Referrer-Policy', 'no-referrer');
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      return new Response(error instanceof AuthorizationError ? error.description : 'This client could not be verified. Start connecting again.', {
        status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    return oauthFailure(error, env);
  }
}

export async function listOAuthConnections(env: Env, actor: string) {
  const rows = await env.DB.prepare(`SELECT c.id,c.name,c.scopes,c.created_at,c.expires_at,c.last_used_at,c.revoked_at,m.address
    FROM oauth_connections c JOIN mailboxes m ON m.id=c.mailbox_id WHERE c.user_id=? ORDER BY c.created_at DESC`)
    .bind(await oauthUserId(actor)).all<{ scopes: string }>();
  return rows.results.map(c => ({ ...c, scopes: JSON.parse(c.scopes) }));
}

export async function revokeOAuthConnection(env: Env, actor: string, id: string) {
  const userId = await oauthUserId(actor);
  const row = await env.DB.prepare('UPDATE oauth_connections SET revoked_at=? WHERE id=? AND user_id=? RETURNING grant_id,mailbox_id')
    .bind(now(), id, userId).first<{ grant_id: string | null; mailbox_id: string }>();
  if (!row) throw new AppError(404, 'Connection not found');
  if (row.grant_id) await getOAuthApi(options(env), env).revokeGrant(row.grant_id, userId);
  await audit(env, actor, 'oauth.revoked', row.mailbox_id, { connectionId: id });
}
