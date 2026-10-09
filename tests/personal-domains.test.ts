import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup, boxA, boxB } from './helpers';
import { accountPrincipal } from '../worker/src/accounts';
import { connectDomain, domainEnv, receiveRelay, relaySource, sendDomainEmail } from '../worker/src/personal-domains';
import { decryptConfig } from '../worker/src/settings';
import { hash, type Principal } from '../worker/src/model';
let f: ReturnType<typeof setup>;
let user: Principal;
const zone = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', account = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const token = 'a-user-owned-cloudflare-token';
let upload: FormData | undefined;
beforeEach(async () => {
  f = setup(); f.env.CONFIG_ENCRYPTION_KEY = btoa('k'.repeat(32));
  user = await accountPrincipal(f.env, { actor: 'guest@example.net', scopes: ['read', 'send'] });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    let result: unknown;
    if (path === `/client/v4/zones/${zone}`) result = { id: zone, name: 'guest.example', status: 'active', account: { id: account } };
    else if (path.endsWith('/email/routing')) result = { enabled: true };
    else if (path.endsWith('/dns_records')) result = [{ content: 'route1.mx.cloudflare.net' }];
    else if (path.endsWith('/email/sending/subdomains')) result = [{ name: 'guest.example', enabled: true }];
    else if (path.endsWith('/email/routing/rules')) result = [];
    else if (path.includes('/workers/scripts/')) { upload = init?.body as FormData; result = {}; }
    else throw new Error(`Unexpected URL: ${url}`);
    return Response.json({ success: true, result });
  });
});
afterEach(() => { f.close(); vi.restoreAllMocks(); });
async function connect() { return connectDomain(f.env, user, { zoneId: zone, token }); }
async function signed(to: string, raw = 'From: sender@example.org\r\nSubject: hello\r\n\r\nPersonal domain mail') {
  const row = f.sql.prepare('SELECT credentials FROM domain_connections WHERE domain_id=?').get(zone)!;
  const { relaySecret } = await decryptConfig<{ relaySecret: string }>(f.env, zone, row.credentials as string);
  const time = String(Date.now()), from = 'sender@example.org';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(relaySecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify([time, from, to, await hash(raw)])));
  return new Request(`https://mcp.mail.example.com/inbound/${zone}`, { method: 'POST', body: raw, headers: {
    'x-mailhq-from': from, 'x-mailhq-to': to, 'x-mailhq-time': time,
    'x-mailhq-signature': Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join(''),
  } });
}
describe('personal Cloudflare domains', () => {
  it('verifies zone ownership, installs a private relay and encrypts per-domain credentials', async () => {
    const result = await connect();
    expect(result.sending).toBe(true);
    expect(f.sql.prepare('SELECT owner_id FROM domains WHERE id=?').get(zone)?.owner_id).toBe(user.userId);
    const row = f.sql.prepare('SELECT * FROM domain_connections').get()!;
    expect(row.credentials).not.toContain(token);
    expect(row.ready).toBe(1);
    expect(await domainEnv(f.env, zone)).toMatchObject({ ACCOUNT_ID: account, CF_API_TOKEN: token, EMAIL_WORKER_NAME: result.workerName });
    const metadata = JSON.parse(upload!.get('metadata') as string);
    expect(metadata.bindings[0].type).toBe('secret_text');
    expect(await (upload!.get('relay.js') as Blob).text()).toContain(`/inbound/${zone}`);
    expect(relaySource('https://example.org')).not.toContain('async fetch');
  });
  it('prevents another user taking over an existing domain, including after a failed installation', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => String(url).includes('/workers/scripts/') ? Promise.resolve(Response.json({ success: false }, { status: 403 })) : original(url, init));
    await expect(connect()).rejects.toThrow('Could not install');
    expect(f.sql.prepare('SELECT ready FROM domain_connections').get()?.ready).toBe(0);
    await expect(domainEnv(f.env, zone)).rejects.toThrow('Finish connecting');
    const attacker = await accountPrincipal(f.env, { actor: 'attacker@example.net', scopes: ['read', 'send'] });
    await expect(connectDomain(f.env, attacker, { zoneId: zone, token })).rejects.toThrow('another account');
    vi.mocked(fetch).mockImplementation(original);
    await connect();
    expect(f.sql.prepare('SELECT ready FROM domain_connections').get()?.ready).toBe(1);
  });
  it('does not replace external MX or create routes during onboarding', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => String(url).includes('/dns_records') ? Promise.resolve(Response.json({ success: true, result: [{ content: 'mx.other-provider.example' }] })) : original(url, init));
    await expect(connect()).rejects.toThrow('Enable Cloudflare Email Routing');
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM domain_connections').get()?.n).toBe(0);
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  it('authenticates relay messages, binds them to one domain and deduplicates retries', async () => {
    await connect();
    f.sql.prepare('UPDATE mailboxes SET domain_id=?,address=?,owner_id=? WHERE id=?').run(zone, 'hello@guest.example', user.userId!, boxB);
    expect((await receiveRelay(await signed('hello@guest.example'), f.env, zone)).status).toBe(204);
    expect((await receiveRelay(await signed('hello@guest.example'), f.env, zone)).status).toBe(204);
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(1);
    expect((await receiveRelay(await signed('research@example.com'), f.env, zone)).status).toBe(404);
    const tampered = await signed('hello@guest.example'); tampered.headers.set('x-mailhq-to', 'research@example.com');
    expect((await receiveRelay(tampered, f.env, zone)).status).toBe(401);
    const expired = await signed('hello@guest.example'); expired.headers.set('x-mailhq-time', '1');
    expect((await receiveRelay(expired, f.env, zone)).status).toBe(401);
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM messages WHERE mailbox_id=?').get(boxA)?.n).toBe(0);
  });
  it('runs the generated relay source against the hosted receiver', async () => {
    await connect();
    f.sql.prepare('UPDATE mailboxes SET domain_id=?,address=?,owner_id=? WHERE id=?').run(zone, 'hello@guest.example', user.userId!, boxB);
    const row = f.sql.prepare('SELECT credentials FROM domain_connections WHERE domain_id=?').get(zone)!;
    const { relaySecret } = await decryptConfig<{ relaySecret: string }>(f.env, zone, row.credentials as string);
    const relay = new Function(relaySource(`https://mcp.mail.example.com/inbound/${zone}`).replace('export default', 'return'))() as { email(message: object, env: object): Promise<void> };
    vi.mocked(fetch).mockImplementation(async (url, init) => receiveRelay(new Request(String(url), init), f.env, zone));
    const raw = new TextEncoder().encode('From: sender@example.org\r\nSubject: generated relay\r\n\r\nhello');
    const reject = vi.fn();
    await relay.email({ to: 'hello@guest.example', from: 'sender@example.org', raw: new Blob([raw]).stream(), rawSize: raw.length, setReject: reject }, { RELAY_SECRET: relaySecret });
    expect(reject).not.toHaveBeenCalled();
    expect(f.sql.prepare('SELECT subject FROM messages').get()?.subject).toBe('generated relay');
  });

  it('sends through the domain account with REST-specific fields and encoded attachments', async () => {
    await connect();
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${account}/email/sending/send`);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      expect(JSON.parse(init!.body as string)).toMatchObject({ from: { address: 'hello@guest.example', name: 'Guest' }, to: ['friend@example.org'], attachments: [{ content: 'aGVsbG8=' }] });
      return Response.json({ success: true, result: { delivered: [], queued: ['friend@example.org'], permanent_bounces: [] } });
    });
    expect(await sendDomainEmail(f.env, zone, { from: { email: 'hello@guest.example', name: 'Guest' }, to: ['friend@example.org'], text: 'hello', subject: 'test', attachments: [{ filename: 'hi.txt', type: 'text/plain', disposition: 'attachment', content: new TextEncoder().encode('hello') }] })).toEqual({ messageId: null });
    expect(f.send).not.toHaveBeenCalled();
  });
});
