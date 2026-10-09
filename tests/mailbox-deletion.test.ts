import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteMailbox } from '../worker/src/mailboxes';
import { fetchApi } from '../worker/src/index';
import { agentAuth } from '../worker/src/auth';
import { hash } from '../worker/src/model';
import { receiveEmail } from '../worker/src/mail';
import { boxA, boxB, setup } from './helpers';

const fixtures: ReturnType<typeof setup>[] = [];
const token = `mhq_${'a'.repeat(43)}`;
async function fixture(managed = true) {
  const f = setup();
  fixtures.push(f);
  f.sql.exec(
    `UPDATE domains SET routing_mode='${managed ? 'managed' : 'literal'}' WHERE name='example.com'`,
  );
  for (const id of [boxA, boxB]) {
    f.sql
      .prepare(
        "INSERT INTO messages(id,mailbox_id,thread_id,direction,sender,subject,body_key,raw_key,created_at) VALUES(?,?,?,'inbound','sender@example.com','Private message',?,?,datetime('now'))",
      )
      .run(
        `message-${id}`,
        id,
        `message-${id}`,
        `mail/${id}/message/body.json`,
        `mail/${id}/message/original.eml`,
      );
    f.sql
      .prepare(
        "INSERT INTO attachments(id,mailbox_id,message_id,filename,content_type,size,object_key) VALUES(?,?,?,'file.txt','text/plain',4,?)",
      )
      .run(`attachment-${id}`, id, `message-${id}`, `mail/${id}/message/attachments/file`);
    f.sql
      .prepare("INSERT INTO drafts(id,mailbox_id,data,updated_at) VALUES(?,?,'{}',datetime('now'))")
      .run(`draft-${id}`, id);
    f.sql
      .prepare(
        "INSERT INTO agent_tokens(id,mailbox_id,name,token_hash,prefix,scopes,expires_at) VALUES(?,?,'Agent',?,'mhq_','[\"read\"]','2099-01-01')",
      )
      .run(`token-${id}`, id, await hash(id === boxA ? token : 'other-token'));
    f.sql
      .prepare(
        "INSERT INTO mail_app_passwords(id,mailbox_id,name,password_hash,prefix) VALUES(?,?,'Phone',?,'mhq_app_')",
      )
      .run(`app-${id}`, id, `password-${id}`);
    f.sql
      .prepare(
        "INSERT INTO oauth_connections(id,user_id,client_id,name,mailbox_id,scopes,expires_at) VALUES(?,'user','client','Agent',?,'[\"read\"]','2099-01-01')",
      )
      .run(`oauth-${id}`, id);
    f.sql
      .prepare('INSERT INTO imap_submissions(dedupe_key,mailbox_id,source_id) VALUES(?,?,?)')
      .run(`submission-${id}`, id, `message-${id}`);
    for (const key of [
      `mail/${id}/message/body.json`,
      `mail/${id}/message/original.eml`,
      `mail/${id}/message/attachments/file`,
      `uploads/${id}/unsent`,
      `imap/${id}/1.eml`,
    ])
      f.objects.set(key, new TextEncoder().encode('private'));
  }
  f.objects.set('system/provisioning-token', new Uint8Array([1]));
  if (!managed) {
    f.env.CF_API_TOKEN = 'test-only';
    f.sql.prepare('UPDATE mailboxes SET routing_rule_id=? WHERE id=?').run('owned-rule', boxA);
  }
  return f;
}
const ownRule = {
  id: 'owned-rule',
  matchers: [{ type: 'literal', field: 'to', value: 'research@example.com' }],
  actions: [{ type: 'worker', value: ['mail-hq'] }],
};
const cf = (result: unknown) => Response.json({ success: true, result });
const denied = () =>
  Response.json({ success: false, errors: [{ message: 'Authentication error' }] }, { status: 403 });
const missing = () =>
  Response.json({ success: false, errors: [{ message: 'ID not found' }] }, { status: 404 });
function provider(rule: unknown = ownRule) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (_url, init) => cf(init?.method === 'DELETE' ? null : rule));
}
const exists = (f: ReturnType<typeof setup>, id = boxA) =>
  f.sql.prepare('SELECT * FROM mailboxes WHERE id=?').get(id);
const deleteRequest = (address = 'research@example.com', origin = 'http://localhost') =>
  new Request(`http://localhost/api/mailboxes/${boxA}`, {
    method: 'DELETE',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  });
afterEach(() => {
  vi.restoreAllMocks();
  fixtures.splice(0).forEach((f) => f.close());
});

describe('mailbox deletion', () => {
  it('discards a delivery that finishes uploading after its mailbox was deleted', async () => {
    const f = await fixture();
    const put = f.env.MAIL_STORE.put.bind(f.env.MAIL_STORE);
    let deleted = false;
    vi.spyOn(f.env.MAIL_STORE, 'put').mockImplementation(async (...args) => {
      if (!deleted) {
        deleted = true;
        await deleteMailbox(f.env, 'owner', boxA, 'research@example.com');
      }
      return put(...args);
    });
    const raw =
      'From: sender@example.com\r\nTo: research@example.com\r\nSubject: Arriving during deletion\r\n\r\nPrivate body';
    const reject = vi.fn();
    await receiveEmail(
      {
        to: 'research@example.com',
        rawSize: raw.length,
        raw: new Blob([raw]).stream(),
        setReject: reject,
      } as unknown as ForwardableEmailMessage,
      f.env,
    );
    expect(reject).toHaveBeenCalledOnce();
    expect(exists(f)).toBeUndefined();
    expect([...f.objects.keys()].some((key) => key.includes(boxA))).toBe(false);
    expect(exists(f, boxB)?.status).toBe('active');
  });

  it('discards an attachment upload that finishes after deletion', async () => {
    const f = await fixture();
    const put = f.env.MAIL_STORE.put.bind(f.env.MAIL_STORE);
    vi.spyOn(f.env.MAIL_STORE, 'put').mockImplementation(async (...args) => {
      await deleteMailbox(f.env, 'owner', boxA, 'research@example.com');
      return put(...args);
    });
    const response = await fetchApi(
      new Request(`http://localhost/api/attachments?mailboxId=${boxA}`, {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Content-Type': 'text/plain' },
        body: 'Private attachment',
      }),
      f.env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(response?.status).toBe(409);
    expect([...f.objects.keys()].some((key) => key.includes(boxA))).toBe(false);
  });

  it('removes a managed mailbox, its private data and credentials while preserving another mailbox and domain', async () => {
    const f = await fixture();
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(
      agentAuth(
        new Request('http://localhost/mcp', { headers: { Authorization: `Bearer ${token}` } }),
        f.env,
      ),
    ).resolves.toMatchObject({ mailboxId: boxA });
    await expect(
      deleteMailbox(f.env, 'owner', boxA, 'research@example.com'),
    ).resolves.toMatchObject({ ok: true, address: 'research@example.com' });
    expect(exists(f)).toBeUndefined();
    expect(exists(f, boxB)?.status).toBe('active');
    for (const table of [
      'messages',
      'attachments',
      'drafts',
      'imap_entries',
      'imap_submissions',
      'agent_tokens',
      'mail_app_passwords',
      'oauth_connections',
    ]) {
      expect(
        f.sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE mailbox_id=?`).get(boxA)?.n,
      ).toBe(0);
      expect(
        Number(f.sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE mailbox_id=?`).get(boxB)?.n),
      ).toBeGreaterThan(0);
    }
    expect(
      f.sql
        .prepare('SELECT COUNT(*) AS n FROM message_search_chunks WHERE message_id=?')
        .get(`message-${boxA}`)?.n,
    ).toBe(0);
    expect(
      f.sql
        .prepare(
          "SELECT COUNT(*) AS n FROM message_search_fts WHERE message_search_fts MATCH 'Private'",
        )
        .get()?.n,
    ).toBe(1);
    expect([...f.objects.keys()].some((key) => key.includes(boxA))).toBe(false);
    expect([...f.objects.keys()].filter((key) => key.includes(boxB))).toHaveLength(5);
    expect(f.objects.has('system/provisioning-token')).toBe(true);
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM domains').get()?.n).toBe(2);
    expect(
      f.sql.prepare("SELECT detail FROM audit_events WHERE action='mailbox.deleted'").get()?.detail,
    ).toBe('{"address":"research@example.com"}');
    await expect(
      agentAuth(
        new Request('http://localhost/mcp', { headers: { Authorization: `Bearer ${token}` } }),
        f.env,
      ),
    ).rejects.toThrow('revoked');
    const reject = vi.fn();
    await receiveEmail(
      { to: 'research@example.com', setReject: reject } as unknown as ForwardableEmailMessage,
      f.env,
    );
    expect(reject).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks and removes only the mailbox’s own literal Worker rule', async () => {
    const f = await fixture(false);
    const fetch = provider();
    await deleteMailbox(f.env, 'owner', boxA, 'research@example.com');
    expect(
      fetch.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init?.method || 'GET']),
    ).toEqual([
      ['/client/v4/zones/11111111111111111111111111111111/email/routing/rules/owned-rule', 'GET'],
      [
        '/client/v4/zones/11111111111111111111111111111111/email/routing/rules/owned-rule',
        'DELETE',
      ],
    ]);
  });

  it.each([
    { ...ownRule, matchers: [{ type: 'all' }] },
    { ...ownRule, matchers: [{ type: 'literal', field: 'to', value: 'someone-else@example.com' }] },
    { ...ownRule, actions: [{ type: 'forward', value: ['owner@external.example'] }] },
    { ...ownRule, actions: [{ type: 'worker', value: ['another-worker'] }] },
  ])('refuses a changed or shared delivery rule: %j', async (rule) => {
    const f = await fixture(false);
    const fetch = provider(rule);
    await expect(deleteMailbox(f.env, 'owner', boxA, 'research@example.com')).rejects.toThrow(
      'changed outside Mail HQ',
    );
    expect(exists(f)?.status).toBe('active');
    expect(f.objects.size).toBe(11);
    expect(fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it.each(['GET', 'DELETE'])(
    'keeps all mail and restores active status on a denied %s',
    async (method) => {
      const f = await fixture(false);
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
        (init?.method || 'GET') === method ? denied() : cf(ownRule),
      );
      await expect(deleteMailbox(f.env, 'owner', boxA, 'research@example.com')).rejects.toThrow(
        'Email Routing Rules → Edit',
      );
      expect(exists(f)?.status).toBe('active');
      expect(exists(f)?.deletion_started_at).toBeNull();
      expect(f.objects.size).toBe(11);
    },
  );

  it('can finish deletion when the owned route is already absent', async () => {
    const f = await fixture(false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(missing());
    await deleteMailbox(f.env, 'owner', boxA, 'research@example.com');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(exists(f)).toBeUndefined();
  });

  it('finds a route left by interrupted provisioning on a later page', async () => {
    const f = await fixture(false);
    f.sql.prepare('UPDATE mailboxes SET routing_rule_id=NULL WHERE id=?').run(boxA);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (init?.method === 'DELETE') return cf(null);
      const url = new URL(String(input));
      expect(url.searchParams.get('per_page')).toBe('50');
      return cf(
        url.searchParams.get('page') === '1'
          ? Array.from({ length: 50 }, (_, i) => ({
              ...ownRule,
              id: String(i),
              matchers: [{ value: `other${i}@example.com` }],
            }))
          : [ownRule],
      );
    });
    await deleteMailbox(f.env, 'owner', boxA, 'research@example.com');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(exists(f)).toBeUndefined();
  });

  it('requires the exact address before any mutation', async () => {
    const f = await fixture(false);
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(deleteMailbox(f.env, 'owner', boxA, 'personal@example.com')).rejects.toThrow(
      'full email address',
    );
    expect(exists(f)?.status).toBe('active');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses deletion of protected addresses and rules', async () => {
    const f = await fixture(false);
    f.sql
      .prepare('INSERT INTO protected_addresses(address,domain_id,routing_rule_id) VALUES(?,?,?)')
      .run('research@example.com', '11111111111111111111111111111111', 'owned-rule');
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(deleteMailbox(f.env, 'owner', boxA, 'research@example.com')).rejects.toThrow(
      'protected',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(exists(f)?.status).toBe('active');
  });

  it('resumes storage cleanup without needing the token again and keeps access disabled in between', async () => {
    const f = await fixture(false);
    const fetch = provider();
    const remove = vi
      .spyOn(f.env.MAIL_STORE, 'delete')
      .mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(deleteMailbox(f.env, 'owner', boxA, 'research@example.com')).rejects.toThrow(
      'Deletion is incomplete',
    );
    expect(exists(f)?.status).toBe('paused');
    expect(exists(f)?.routing_rule_id).toBeNull();
    expect(exists(f)?.deletion_started_at).toBeTruthy();
    await expect(
      agentAuth(
        new Request('http://localhost/mcp', { headers: { Authorization: `Bearer ${token}` } }),
        f.env,
      ),
    ).rejects.toThrow('inactive');
    delete f.env.CF_API_TOKEN;
    await deleteMailbox(f.env, 'owner', boxA, 'research@example.com');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalled();
    expect(exists(f)).toBeUndefined();
  });

  it('can retry an atomic metadata cleanup failure after storage was removed', async () => {
    const f = await fixture();
    vi.spyOn(f.env.DB, 'batch').mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(deleteMailbox(f.env, 'owner', boxA, 'research@example.com')).rejects.toThrow(
      'Deletion is incomplete',
    );
    expect(exists(f)?.status).toBe('paused');
    await deleteMailbox(f.env, 'owner', boxA, 'research@example.com');
    expect(exists(f)).toBeUndefined();
    expect(exists(f, boxB)).toBeTruthy();
  });

  it('cleans every storage page and does not match neighboring key prefixes', async () => {
    const f = await fixture();
    for (let i = 0; i < 1250; i++) f.objects.set(`mail/${boxA}/${i}`, new Uint8Array([1]));
    f.objects.set(`mail/${boxA}-other/keep`, new Uint8Array([1]));
    const list = vi.spyOn(f.env.MAIL_STORE, 'list');
    await deleteMailbox(f.env, 'owner', boxA, 'research@example.com');
    expect(list.mock.calls.filter(([options]) => options?.prefix === `mail/${boxA}/`)).toHaveLength(
      3,
    );
    expect(f.objects.has(`mail/${boxA}-other/keep`)).toBe(true);
  });

  it('exposes deletion only behind dashboard authentication, origin checks, and address confirmation', async () => {
    const f = await fixture();
    const context = { waitUntil() {} } as unknown as ExecutionContext;
    expect(
      (
        await fetchApi(
          deleteRequest('research@example.com', 'https://attacker.example'),
          f.env,
          context,
        )
      )?.status,
    ).toBe(403);
    expect((await fetchApi(deleteRequest('wrong@example.com'), f.env, context))?.status).toBe(400);
    f.env.LOCAL_DEV = 'false';
    expect(
      (
        await fetchApi(
          new Request(`${f.env.APP_ORIGIN}/api/mailboxes/${boxA}`, {
            method: 'DELETE',
            headers: { Origin: f.env.APP_ORIGIN },
          }),
          f.env,
          context,
        )
      )?.status,
    ).toBe(401);
    expect(exists(f)).toBeTruthy();
    f.env.LOCAL_DEV = 'true';
    const response = await fetchApi(deleteRequest(), f.env, context);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ok: true, id: boxA });
    expect(exists(f)).toBeUndefined();
  });
});
