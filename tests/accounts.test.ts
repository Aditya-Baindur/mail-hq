import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boxA, boxB, setup } from './helpers';
import { accountPrincipal } from '../worker/src/accounts';
import { fetchApi } from '../worker/src/index';
import { receiveEmail } from '../worker/src/mail';
vi.mock('../worker/src/auth', async (original) => ({
  ...await original<typeof import('../worker/src/auth')>(),
  dashboardAuth: async (request: Request) => ({ actor: request.headers.get('test-user') || 'owner@example.net', scopes: ['read', 'send'] }),
}));
let f: ReturnType<typeof setup>;
const other = 'guest@example.net';
beforeEach(async () => {
  f = setup();
  await accountPrincipal(f.env, { actor: 'owner@example.net', scopes: ['read', 'send'] });
  await accountPrincipal(f.env, { actor: other, scopes: ['read', 'send'] });
  f.sql.prepare('UPDATE mailboxes SET owner_id=? WHERE id=?').run(other, boxB);
  for (const to of ['research@example.com', 'personal@example.com']) {
    const raw = new TextEncoder().encode(`From: sender@example.org\r\nTo: ${to}\r\nSubject: private ${to}\r\n\r\nPrivate body`);
    await receiveEmail({ to, raw: new Blob([raw]).stream(), rawSize: raw.length, setReject: vi.fn() } as unknown as ForwardableEmailMessage, f.env);
  }
});
afterEach(() => f.close());
async function call(path: string, user = other, method = 'GET', body?: unknown) {
  return (await fetchApi(new Request(`https://mail.example.com/api${path}`, { method,
    headers: { 'test-user': user, origin: 'https://mail.example.com', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), f.env, { waitUntil() {} } as unknown as ExecutionContext))!;
}
describe('private hosted accounts', () => {
  it('does not award existing mail to the first visitor or an unconfigured owner', async () => {
    f.sql.exec('UPDATE mailboxes SET owner_id=NULL; UPDATE domains SET owner_id=NULL');
    const p = await accountPrincipal({ ...f.env, OWNER_EMAIL: '' }, { actor: other, scopes: ['read'] });
    expect(p.isAdmin).toBe(false);
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM mailboxes WHERE owner_id IS NULL').get()?.n).toBe(2);
    await accountPrincipal(f.env, { actor: 'OWNER@example.net', scopes: ['read'] });
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM mailboxes WHERE owner_id=?').get('owner@example.net')?.n).toBe(2);
  });
  it('isolates bootstrap, search, counts and activity even for the owner', async () => {
    for (const [user, id, address] of [[other, boxB, 'personal@example.com'], ['owner@example.net', boxA, 'research@example.com']]) {
      const bootstrap = await (await call('/bootstrap', user)).json<{ mailboxes: { id: string }[]; counts: { mailbox_id: string }[] }>();
      expect(bootstrap.mailboxes.map((b: { id: string }) => b.id)).toEqual([id]);
      expect(bootstrap.counts.every((c: { mailbox_id: string }) => c.mailbox_id === id)).toBe(true);
      const list = await (await call('/messages?q=private', user)).json<{ total: number; messages: { mailbox_id: string }[] }>();
      expect(list.total).toBe(1);
      expect(list.messages[0].mailbox_id).toBe(id);
      const stats = await (await call('/stats', user)).json<{ totals: { total: number }; mailboxes: { address: string }[] }>();
      expect(stats.totals.total).toBe(1);
      expect(stats.mailboxes.map((b: { address: string }) => b.address)).toEqual([address]);
    }
  });
  it('denies direct message, raw, thread, attachment, send and deletion access', async () => {
    const m = f.sql.prepare('SELECT id FROM messages WHERE mailbox_id=?').get(boxA)!.id;
    for (const suffix of ['', '/thread', '/raw']) expect((await call(`/messages/${m}${suffix}`)).status).toBe(404);
    expect((await call(`/messages/${m}`, other, 'PATCH', { starred: true })).status).toBe(404);
    expect((await call(`/messages?mailboxId=${boxA}`)).status).toBe(404);
    expect((await call(`/attachments?mailboxId=${boxA}`, other, 'POST', 'secret')).status).toBe(404);
    expect((await call(`/mailboxes/${boxA}`, other, 'DELETE', { address: 'research@example.com' })).status).toBe(404);
    expect((await call('/send', other, 'POST', { mailboxId: boxA, to: ['a@example.org'], subject: 'x', text: 'x', html: '', idempotencyKey: crypto.randomUUID() })).status).toBe(404);
  });
  it('cannot overwrite or delete another account’s draft, or mint credentials', async () => {
    const id = crypto.randomUUID();
    f.sql.prepare('INSERT INTO drafts VALUES(?,?,?,?)').run(id, boxA, '{}', new Date().toISOString());
    expect((await call(`/drafts/${id}`, other, 'PUT', { mailboxId: boxB, data: {} })).status).toBe(404);
    expect((await call(`/drafts/${id}`, other, 'DELETE')).status).toBe(404);
    expect((await call('/tokens', other, 'POST', { mailboxId: boxA, name: 'stolen', scopes: ['read'] })).status).toBe(404);
    expect((await call('/mail-apps', other, 'POST', { mailboxId: boxA, name: 'stolen' })).status).toBe(404);
    expect(f.sql.prepare('SELECT mailbox_id FROM drafts WHERE id=?').get(id)?.mailbox_id).toBe(boxA);
  });
  it('hides credentials and attachments and rejects revocation of another user’s connections', async () => {
    const owner = 'owner@example.net';
    f.env.BRIDGE_HOST = 'imap.example.com'; f.env.BRIDGE_API_SECRET = 'bridge-test-secret';
    const token = await (await call('/tokens', owner, 'POST', { mailboxId: boxA, name: 'owner token', scopes: ['read'] })).json<{ id: string }>();
    const password = await (await call('/mail-apps', owner, 'POST', { mailboxId: boxA, name: 'owner phone' })).json<{ id: string }>();
    expect((await (await call('/tokens')).json<{ tokens: unknown[] }>()).tokens).toEqual([]);
    expect((await (await call('/mail-apps')).json<{ connections: unknown[] }>()).connections).toEqual([]);
    expect((await call(`/tokens/${token.id}`, other, 'DELETE')).status).toBe(404);
    expect((await call(`/mail-apps/${password.id}`, other, 'DELETE')).status).toBe(404);
    expect((await call(`/mail-apps/${password.id}/apple.mobileconfig`)).status).toBe(404);
    const attachment = await (await call(`/attachments?mailboxId=${boxA}`, owner, 'POST', 'private attachment')).json<{ id: string }>();
    expect((await call(`/attachments/${attachment.id}`)).status).toBe(404);
    expect((await call(`/attachments/${attachment.id}`, owner)).status).toBe(200);
  });
  it('protects shared infrastructure and domain ownership', async () => {
    expect((await call('/settings/cloudflare-token', other, 'POST', { token: 'x'.repeat(30) })).status).toBe(403);
    expect((await call('/domains/sync', other, 'POST')).status).toBe(403);
    expect((await call('/mailboxes', other, 'POST', { localPart: 'stolen', domainId: '11111111111111111111111111111111' })).status).toBe(404);
  });
});
