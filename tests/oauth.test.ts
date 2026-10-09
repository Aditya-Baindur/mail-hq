import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { fetchApi } from '../worker/src/index';
import { hash } from '../worker/src/model';
import { boxA, boxB, setup } from './helpers';

const app = 'https://mail.example.com', issuer = 'https://mcp.mail.example.com', resource = `${issuer}/mcp`;
let fixture: ReturnType<typeof setup>;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: Awaited<ReturnType<typeof exportJWK>>[] };
const metadata = new Map<string, object>();
const secret = () => btoa(String.fromCharCode(...randomBytes(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'oauth-test-key', alg: 'RS256' }] };
});
beforeEach(() => {
  fixture = setup();
  metadata.clear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url) === `${fixture.env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`) return Response.json(jwks);
    if (metadata.has(String(url))) return Response.json(metadata.get(String(url)));
    throw new Error(`Unexpected network request: ${String(url)}`);
  });
});
afterEach(() => { fixture.close(); vi.restoreAllMocks(); });
async function session(email = 'owner@example.net') {
  return new SignJWT({ email, type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'oauth-test-key' })
    .setJti(crypto.randomUUID()).setIssuer(fixture.env.ACCESS_TEAM_DOMAIN).setAudience(fixture.env.ACCESS_AUD).setSubject(email)
    .setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
}
async function request(url: string, init?: RequestInit) {
  const pending: Promise<unknown>[] = [];
  const result = await fetchApi(new Request(url, init), fixture.env, { waitUntil(p: Promise<unknown>) { pending.push(p); } } as unknown as ExecutionContext);
  await Promise.all(pending);
  if (!result) throw new Error('Request was not handled');
  return result;
}
async function register(redirect = 'http://127.0.0.1:1455/callback', extra: Record<string, unknown> = {}) {
  const response = await request(`${issuer}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    client_name: 'Codex test', redirect_uris: [redirect], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...extra,
  }) });
  expect(response.status).toBe(201);
  const client = await response.json() as { client_id: string };
  return { id: client.client_id, redirect };
}
type Client = Awaited<ReturnType<typeof register>>;
async function consent(client?: Client, overrides: Record<string, string> = {}, email?: string) {
  client ||= await register();
  const verifier = secret();
  const query = new URLSearchParams({ client_id: client.id, redirect_uri: client.redirect, response_type: 'code',
    resource, state: 'client-state', scope: 'mail:read offline_access', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), ...overrides });
  const jwt = await session(email);
  const url = `${app}/oauth/authorize?${query}`;
  const response = await request(url, { headers: { 'cf-access-jwt-assertion': jwt } });
  const html = await response.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1] || '';
  const cookie = response.headers.get('set-cookie')?.split(';')[0] || '';
  return { client, verifier, jwt, url, response, html, handle, cookie };
}
type Consent = Awaited<ReturnType<typeof consent>>;
async function approve(c: Consent, fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return request(`${app}/oauth/authorize`, { method: 'POST', headers: {
    'Content-Type': 'application/x-www-form-urlencoded', Origin: app, 'cf-access-jwt-assertion': c.jwt, Cookie: c.cookie, ...headers,
  }, body: new URLSearchParams({ handle: c.handle, mailboxId: boxA, decision: 'approve', read: 'yes', ...fields }) });
}
async function token(body: Record<string, string>) {
  return request(`${issuer}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
}
async function code(c: Consent, fields: Record<string, string> = {}) {
  expect(c.response.status, c.html).toBe(200);
  const response = await approve(c, fields);
  expect(response.status, await response.clone().text()).toBe(302);
  const redirect = new URL(response.headers.get('location')!);
  expect(redirect.searchParams.get('state')).toBe('client-state');
  expect(redirect.searchParams.get('iss')).toBe(issuer);
  return { grant_type: 'authorization_code', client_id: c.client.id, redirect_uri: c.client.redirect,
    code: redirect.searchParams.get('code')!, code_verifier: c.verifier, resource };
}
async function connect(fields: Record<string, string> = {}, client?: Client) {
  const c = await consent(client);
  const response = await token(await code(c, fields));
  expect(response.status, await response.clone().text()).toBe(200);
  const tokens = await response.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string };
  return { ...tokens, client: c.client };
}
async function rpc(access: string, method = 'tools/list', params: object = {}) {
  return request(resource, { method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}

describe('MCP OAuth discovery and approval', () => {
  it('advertises the protected resource, PKCE, CIMD, DCR and the Access-protected authorization page', async () => {
    const unauthorized = await request(resource);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain(`${issuer}/.well-known/oauth-protected-resource/mcp`);
    const protectedResource = await (await request(`${issuer}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(protectedResource).toMatchObject({ resource, authorization_servers: [issuer] });
    const discovery = await (await request(`${issuer}/.well-known/oauth-authorization-server`)).json();
    expect(discovery).toMatchObject({ issuer, authorization_endpoint: `${app}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`, client_id_metadata_document_supported: true, code_challenge_methods_supported: ['S256'] });
    expect((await request(`${app}/oauth/authorize`)).status).toBe(401);
    expect((await request(`${issuer}/oauth/authorize`)).status).toBe(404);
  });
  it.each(['http://127.0.0.1:1455/callback', 'cursor://anysphere.cursor-mcp/oauth/callback', 'https://chatgpt.com/connector_platform_oauth_redirect'])('supports a registered callback: %s', async redirect => {
    const result = await connect({}, await register(redirect));
    expect(result.access_token).toBeTruthy();
    expect(result.expires_in).toBe(3600);
    expect(result.refresh_token).toBeTruthy();
  });
  it('resolves a URL client ID with CIMD without client registration', async () => {
    const id = 'https://chatgpt.com/oauth/client.json', redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
    metadata.set(id, { client_id: id, client_name: 'ChatGPT', redirect_uris: [redirect], token_endpoint_auth_method: 'none' });
    const result = await connect({}, { id, redirect });
    expect(result.access_token).toBeTruthy();
  });
  it('supports ChatGPT-style CIMD private_key_jwt authentication and rejects replayed assertions', async () => {
    const id = 'https://chatgpt.com/oauth/client.json', redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
    metadata.set(id, { client_id: id, client_name: 'ChatGPT', redirect_uris: [redirect], token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'], token_endpoint_auth_signing_alg: 'RS256', jwks_uri: 'https://chatgpt.com/oauth/jwks.json' });
    metadata.set('https://chatgpt.com/oauth/jwks.json', jwks);
    const c = await consent({ id, redirect });
    expect(c.html).toContain('Client domain: <strong>chatgpt.com</strong>');
    const assertion = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'oauth-test-key' })
      .setIssuer(id).setSubject(id).setAudience(`${issuer}/oauth/token`).setJti(crypto.randomUUID()).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    const assertionFields = { client_assertion: assertion, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' };
    const response = await token({ ...await code(c), ...assertionFields });
    expect(response.status, await response.clone().text()).toBe(200);
    const granted = await response.json() as { refresh_token: string };
    const replay = await token({ grant_type: 'refresh_token', client_id: id, refresh_token: granted.refresh_token, resource, ...assertionFields });
    expect(replay.status).toBe(401);
  });
  it.each([{ code_challenge: '', code_challenge_method: '' }, { code_challenge_method: 'plain' }, { redirect_uri: 'https://attacker.example/callback' }, { resource: 'https://other.example/mcp' }] as Record<string, string>[])('rejects invalid authorization parameters without redirecting: %j', async overrides => {
    const result = await consent(undefined, overrides);
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get('location')).toBeNull();
  });
  it('escapes client metadata and requires explicit mailbox selection', async () => {
    const c = await consent(await register(undefined, { client_name: '<img src=x onerror=alert(1)>' }));
    expect(c.html).not.toContain('<img');
    expect(c.html).toContain('&#60;img');
    expect(c.html).toContain('disabled selected>Choose the exact email address');
    expect(c.response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(c.response.headers.get('cache-control')).toContain('no-store');
    expect((await approve(c, { mailboxId: '' })).status).toBe(400);
  });
  it('binds consent to the exact Access session, signed identity, origin and a single use', async () => {
    const c = await consent();
    expect((await approve(c, {}, { Cookie: '', 'cf-access-jwt-assertion': await session() })).status).toBe(400);
    expect((await approve(c, {}, { Origin: 'https://attacker.example' })).status).toBe(403);
    const other = await consent();
    expect((await approve(other, {}, { 'cf-access-jwt-assertion': await session('other@example.net') })).status).toBe(404);
    const valid = await consent();
    expect((await approve(valid)).status).toBe(302);
    expect((await approve(valid)).status).toBe(400);
    expect(fixture.sql.prepare('SELECT COUNT(*) AS n FROM oauth_connections').get()?.n).toBe(1);
  });
  it.each(['approve', 'deny'])('recovers an absent secondary cookie only for the original Access session: %s', async decision => {
    const c = await consent(await register('https://www.cursor.com/agents/mcp/oauth/callback'));
    const response = await approve(c, { decision }, { Cookie: '' });
    expect(response.status, await response.clone().text()).toBe(302);
    const callback = new URL(response.headers.get('location')!);
    expect(callback.origin).toBe('https://www.cursor.com');
    expect(callback.searchParams.get('state')).toBe('client-state');
    if (decision === 'approve') {
      const exchanged = await token({ grant_type: 'authorization_code', client_id: c.client.id,
        redirect_uri: c.client.redirect, code: callback.searchParams.get('code')!, code_verifier: c.verifier, resource });
      expect(exchanged.status).toBe(200);
    } else expect(callback.searchParams.get('error')).toBe('access_denied');
    expect((await approve(c, { decision }, { Cookie: '' })).status).toBe(400);
  });
  it('does not recover absent cookies without verified Access, across sessions, or across origins', async () => {
    const c = await consent();
    expect((await approve(c, {}, { Cookie: '', 'cf-access-jwt-assertion': '' })).status).toBe(401);
    expect((await approve(c, {}, { Cookie: '', 'cf-access-jwt-assertion': await session() })).status).toBe(400);
    expect((await approve(c, {}, { Cookie: '', Origin: 'https://attacker.example' })).status).toBe(403);
    expect((await approve(c, {}, { Cookie: '' })).status).toBe(302);
  });
  it('rejects pre-fix identity-only consents and expired consents even in the original session', async () => {
    const old = await consent();
    fixture.sql.prepare('UPDATE oauth_consents SET handle_hash=?').run(await hash(old.handle));
    expect((await approve(old, {}, { Cookie: '' })).status).toBe(400);
    const expired = await consent();
    fixture.sql.exec("UPDATE oauth_consents SET expires_at='2000-01-01'");
    expect((await approve(expired, {}, { Cookie: '' })).status).toBe(400);
  });
  it('does not treat the local-development identity as an authenticated consent session', async () => {
    const c = await consent();
    fixture.env.APP_ORIGIN = 'http://localhost';
    fixture.env.LOCAL_DEV = 'true';
    const response = await request(c.url.replace(app, 'http://localhost'));
    expect(response.status).toBe(401);
  });
  it('never replaces an existing mismatched transaction cookie', async () => {
    const c = await consent();
    expect((await approve(c, {}, { Cookie: `${c.cookie.split('=')[0]}=wrong` })).status).toBe(400);
    expect(fixture.sql.prepare('SELECT COUNT(*) AS n FROM oauth_connections').get()?.n).toBe(0);
  });
  it.each(['approve', 'deny'])('keeps the browser form origin for %s while protecting the callback', async decision => {
    const c = await consent();
    // Fetch's origin-header algorithm sends Origin: null for a navigate-mode
    // POST under no-referrer. The consent page must preserve same-origin POSTs.
    expect(c.response.headers.get('referrer-policy')).toBe('same-origin');
    expect(c.html).toContain('<form method="post" action="/oauth/authorize">');
    const response = await approve(c, { decision }, {
      Origin: app, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document',
    });
    expect(response.status, await response.clone().text()).toBe(302);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const redirect = new URL(response.headers.get('location')!);
    expect(redirect.origin).toBe(new URL(c.client.redirect).origin);
    expect(redirect.searchParams.get('state')).toBe('client-state');
    if (decision === 'approve') {
      const exchanged = await token({ grant_type: 'authorization_code', client_id: c.client.id,
        redirect_uri: c.client.redirect, code: redirect.searchParams.get('code')!, code_verifier: c.verifier, resource });
      expect(exchanged.status).toBe(200);
      const granted = await exchanged.json() as { access_token: string };
      expect((await rpc(granted.access_token)).status).toBe(200);
    } else expect(redirect.searchParams.get('error')).toBe('access_denied');
  });
  it.each(['null', '', 'https://attacker.example', issuer])('still rejects consent from untrusted origin %j', async origin => {
    const c = await consent();
    const rejected = await approve(c, {}, { Origin: origin, 'Sec-Fetch-Site': 'same-origin' });
    expect(rejected.status).toBe(403);
    expect(fixture.sql.prepare('SELECT COUNT(*) AS n FROM oauth_connections').get()?.n).toBe(0);
    // A rejected origin must not consume the legitimate user's approval.
    expect((await approve(c)).status).toBe(302);
  });
  it('cancels without granting access and returns the original state', async () => {
    const response = await approve(await consent(), { decision: 'deny', mailboxId: '' });
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get('location')!);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('client-state');
    expect(fixture.sql.prepare('SELECT COUNT(*) AS n FROM oauth_connections').get()?.n).toBe(0);
  });
});

describe('MCP OAuth tokens and mailbox permissions', () => {
  it('completes discovery, registration, PKCE, refresh and a tool call with the official MCP SDK client', async () => {
    let clientInfo: OAuthClientInformationMixed | undefined, savedTokens: OAuthTokens | undefined;
    let verifier = '', authorizationUrl: URL | undefined;
    const redirect = 'http://127.0.0.1:1455/callback';
    const provider: OAuthClientProvider = {
      redirectUrl: redirect,
      clientMetadata: { client_name: 'SDK interoperability test', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
      clientInformation: () => clientInfo,
      saveClientInformation: value => { clientInfo = value; },
      tokens: () => savedTokens,
      saveTokens: value => { savedTokens = value; },
      redirectToAuthorization: url => { authorizationUrl = url; },
      saveCodeVerifier: value => { verifier = value; },
      codeVerifier: () => verifier,
    };
    const fetchFn = (url: string | URL, init?: RequestInit) => request(String(url), init);
    expect(await auth(provider, { serverUrl: resource, fetchFn })).toBe('REDIRECT');
    expect(authorizationUrl?.origin).toBe(app);
    const jwt = await session();
    const page = await request(String(authorizationUrl), { headers: { 'cf-access-jwt-assertion': jwt } });
    const html = await page.text();
    const approval = await approve({ client: { id: clientInfo!.client_id, redirect }, verifier, jwt, url: String(authorizationUrl), response: page, html,
      handle: html.match(/name="handle" value="([^"]+)"/)![1], cookie: page.headers.get('set-cookie')!.split(';')[0] });
    expect(approval.status).toBe(302);
    const authorizationCode = new URL(approval.headers.get('location')!).searchParams.get('code')!;
    expect(await auth(provider, { serverUrl: resource, authorizationCode, fetchFn })).toBe('AUTHORIZED');
    const initialRefresh = savedTokens!.refresh_token;
    expect(await auth(provider, { serverUrl: resource, fetchFn })).toBe('AUTHORIZED');
    expect(savedTokens!.refresh_token).not.toBe(initialRefresh);
    const client = new McpClient({ name: 'MailHQ integration test', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider, fetch: fetchFn }));
      const result = await client.callTool({ name: 'get_mailbox', arguments: {} });
      expect(JSON.stringify(result)).toContain('research@example.com');
      expect((await client.listTools()).tools.map(t => t.name)).not.toContain('send_mail');
    } finally { await client.close(); }
  });
  it('enforces PKCE, client, redirect and resource binding at token exchange', async () => {
    const c = await consent();
    const body = await code(c);
    for (const override of [{ code_verifier: 'wrong' }, { client_id: (await register()).id }, { redirect_uri: 'https://attacker.example/callback' }, { resource: 'https://other.example/mcp' }]) {
      expect((await token({ ...body, ...override })).status).toBe(400);
    }
    expect((await token(body)).status).toBe(200);
    expect((await token(body)).status).toBe(400);
  });
  it('restricts tools and data to the approved mailbox', async () => {
    const granted = await connect();
    expect(granted.scope).not.toContain('mail:send');
    const tools = await (await rpc(granted.access_token)).json() as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map(t => t.name)).toContain('read_mail');
    expect(tools.result.tools.map(t => t.name)).not.toContain('send_mail');
    const info = await (await rpc(granted.access_token, 'tools/call', { name: 'get_mailbox', arguments: {} })).json() as { result: { content: { text: string }[] } };
    expect(JSON.parse(info.result.content[0].text)).toMatchObject({ id: boxA, permissions: ['read'] });
    fixture.sql.prepare("INSERT INTO messages(id,mailbox_id,thread_id,direction,folder,status,sender,recipients,subject,body_key,size,created_at) VALUES('other-message',?,'other-thread','inbound','inbox','received','sender@example.net','[]','Private','private',10,'2026-10-08')").run(boxB);
    const foreign = await (await rpc(granted.access_token, 'tools/call', { name: 'read_mail', arguments: { messageId: 'other-message' } })).json() as { result: { isError: boolean; content: { text: string }[] } };
    expect(foreign.result.isError).toBe(true);
    expect(JSON.stringify(foreign)).not.toContain('Private');
  });
  it('offers send tools only when approved and preserves separate mailbox grants for one client', async () => {
    const client = await register();
    const first = await connect({ send: 'yes' }, client);
    const second = await connect({ mailboxId: boxB }, client);
    const tools = await (await rpc(first.access_token)).json() as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map(t => t.name)).toContain('send_mail');
    const info = await (await rpc(second.access_token, 'tools/call', { name: 'get_mailbox', arguments: {} })).json() as { result: { content: { text: string }[] } };
    expect(JSON.parse(info.result.content[0].text).id).toBe(boxB);
    expect(fixture.send).not.toHaveBeenCalled();
  });
  it('rotates refresh tokens and honors narrowed token scopes', async () => {
    const granted = await connect({ send: 'yes' });
    const response = await token({ grant_type: 'refresh_token', client_id: granted.client.id, refresh_token: granted.refresh_token, resource, scope: 'mail:read' });
    expect(response.status).toBe(200);
    const next = await response.json() as typeof granted;
    expect(next.refresh_token).not.toBe(granted.refresh_token);
    expect(next.scope).toBe('mail:read');
    const tools = await (await rpc(next.access_token)).json() as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map(t => t.name)).not.toContain('send_mail');
  });
  it('supports send-only approval without granting read access', async () => {
    const granted = await connect({ read: '', send: 'yes' });
    const tools = await (await rpc(granted.access_token)).json() as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map(t => t.name)).toEqual(['get_mailbox', 'send_mail', 'reply_to_mail']);
  });
  it.each(['revoked', 'expired', 'paused'])('blocks access and refresh when %s', async mode => {
    const granted = await connect();
    if (mode === 'revoked') fixture.sql.exec("UPDATE oauth_connections SET revoked_at='2020-01-01'");
    if (mode === 'expired') fixture.sql.exec("UPDATE oauth_connections SET expires_at='2020-01-01'");
    if (mode === 'paused') fixture.sql.exec("UPDATE mailboxes SET status='paused'");
    expect((await rpc(granted.access_token)).status).toBe(401);
    const refreshed = await token({ grant_type: 'refresh_token', client_id: granted.client.id, refresh_token: granted.refresh_token, resource });
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: 'invalid_grant' });
  });
  it('lists and revokes only connections belonging to the signed-in owner', async () => {
    const granted = await connect();
    const id = fixture.sql.prepare('SELECT id FROM oauth_connections').get()!.id as string;
    const headers = { 'cf-access-jwt-assertion': await session(), Origin: app };
    const response = await request(`${app}/api/oauth/connections`, { headers });
    expect(await response.json()).toMatchObject({ connections: [{ id, scopes: ['read'], address: 'research@example.com' }] });
    const wrongOwner = await request(`${app}/api/oauth/connections/${id}`, { method: 'DELETE', headers: { ...headers, 'cf-access-jwt-assertion': await session('other@example.net') } });
    expect(wrongOwner.status).toBe(404);
    expect((await request(`${app}/api/oauth/connections/${id}`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await rpc(granted.access_token)).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', client_id: granted.client.id, refresh_token: granted.refresh_token })).status).toBe(400);
  });
  it('rejects a code if its connection was revoked before the first token exchange', async () => {
    const body = await code(await consent());
    fixture.sql.exec("UPDATE oauth_connections SET revoked_at='2020-01-01'");
    expect((await token(body)).status).toBe(400);
  });
  it('keeps existing manual mailbox tokens working', async () => {
    const access = `mhq_${secret()}`;
    fixture.sql.prepare('INSERT INTO agent_tokens(id,mailbox_id,name,token_hash,prefix,scopes,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), boxA, 'Existing agent', await hash(access), access.slice(0, 8), '["read"]', '2099-01-01');
    expect((await rpc(access)).status).toBe(200);
  });
});
