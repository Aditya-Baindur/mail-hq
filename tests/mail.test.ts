import { afterEach, describe, expect, it, vi } from 'vitest';
import { boxA, boxB, setup } from './helpers';
import { getMessage, listMessages, receiveEmail, sendMail, sendSchema } from '../worker/src/mail';
import { agentAuth, checkOrigin, dashboardAuth } from '../worker/src/auth';
import { hash, limitedBody, now, type Principal } from '../worker/src/model';
import { provision } from '../worker/src/cloudflare';
import { handleMcp } from '../worker/src/mcp';
let stores: ReturnType<typeof setup>[] = [];
const fixture = () => {
  const f = setup();
  stores.push(f);
  return f;
};
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
  vi.restoreAllMocks();
});
const owner: Principal = { actor: 'owner', scopes: ['read', 'send'] };
const agent: Principal = { actor: 'agent:test', mailboxId: boxA, scopes: ['read', 'send'] };
const input = (mailboxId = boxA) =>
  sendSchema.parse({
    mailboxId,
    to: ['recipient@example.com'],
    subject: 'A proper test',
    text: 'Hello from our test.',
    idempotencyKey: crypto.randomUUID(),
  });
async function receive(env: ReturnType<typeof setup>['env'], recipient = 'research@example.com') {
  const raw =
    'From: Alice <alice@example.com>\r\nTo: ' +
    recipient +
    '\r\nSubject: Project update\r\nMessage-ID: <original@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="test"\r\n\r\n--test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHere is the document.\r\n--test\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="notes.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--test--\r\n';
  const message = {
    from: 'alice@example.com',
    to: recipient,
    rawSize: raw.length,
    raw: new Blob([raw]).stream(),
    headers: new Headers(),
    setReject: vi.fn(),
  } as unknown as ForwardableEmailMessage;
  await receiveEmail(message, env);
  return message;
}
describe('mail delivery and storage', () => {
  it('stores received MIME, searchable metadata and private attachments, and deduplicates retries', async () => {
    const { env, sql, objects } = fixture();
    await receive(env);
    await receive(env);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(1);
    const result = await listMessages(env, agent, {});
    expect(result.messages).toHaveLength(1);
    const mail = await getMessage(env, agent, result.messages[0].id);
    expect(mail.text).toContain('Here is the document');
    expect(mail.attachments).toHaveLength(1);
    expect(objects.size).toBe(3);
    expect(Object.keys(mail)).not.toContain('body_key');
    expect(Object.keys(mail)).not.toContain('raw_key');
  });
  it('rejects unknown recipients without retaining their message', async () => {
    const { env, objects } = fixture();
    const message = await receive(env, 'hello@example.com');
    expect(message.setReject).toHaveBeenCalled();
    expect(objects.size).toBe(0);
  });
  it('sends from the assigned mailbox and never duplicates an idempotent retry', async () => {
    const { env, send, sql } = fixture();
    const data = input();
    const one = await sendMail(env, agent, data);
    const two = await sendMail(env, agent, data);
    expect(one.id).toBe(two.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      from: { email: 'research@example.com' },
    });
    expect(sql.prepare('SELECT status FROM messages').get()?.status).toBe('accepted');
  });
  it('preserves reply threading without crossing mailboxes', async () => {
    const { env, send } = fixture();
    await receive(env);
    const list = await listMessages(env, agent, {});
    await sendMail(env, agent, { ...input(), replyToId: list.messages[0].id });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      headers: { 'In-Reply-To': '<original@example.com>', References: '<original@example.com>' },
    });
    await expect(
      sendMail(env, owner, { ...input(boxB), replyToId: list.messages[0].id }),
    ).rejects.toThrow('Reply message not found');
  });
  it('keeps provider failures visible and does not automatically resend', async () => {
    const { env, send, sql } = fixture();
    send.mockRejectedValueOnce(
      Object.assign(new Error('Domain not ready'), { code: 'E_SENDER_NOT_VERIFIED' }),
    );
    const data = input();
    await expect(sendMail(env, agent, data)).rejects.toThrow('Domain not ready');
    expect(sql.prepare('SELECT status FROM messages').get()?.status).toBe('failed');
    await sendMail(env, agent, data);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('records ambiguous provider errors as uncertain and never retries them automatically', async () => {
    const { env, send, sql } = fixture();
    send.mockRejectedValueOnce(new Error('Connection interrupted'));
    const data = input();
    expect((await sendMail(env, agent, data)).status).toBe('uncertain');
    expect(sql.prepare('SELECT status FROM messages').get()?.status).toBe('uncertain');
    await sendMail(env, agent, data);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('rejects attachments belonging to another mailbox', async () => {
    const { env, sql, send } = fixture();
    const id = crypto.randomUUID();
    sql
      .prepare(
        'INSERT INTO attachments(id,mailbox_id,filename,content_type,size,object_key) VALUES(?,?,?,?,?,?)',
      )
      .run(id, boxB, 'private.txt', 'text/plain', 5, 'private');
    await expect(sendMail(env, agent, { ...input(), attachmentIds: [id] })).rejects.toThrow(
      'belongs to another',
    );
    expect(send).not.toHaveBeenCalled();
  });
});
describe('mailbox isolation and authentication', () => {
  it('cannot read another mailbox even when given a known message ID', async () => {
    const { env } = fixture();
    await receive(env, 'personal@example.com');
    const list = await listMessages(env, owner, { mailboxId: boxB });
    await expect(getMessage(env, agent, list.messages[0].id)).rejects.toThrow('Not found');
    expect((await listMessages(env, agent, { mailboxId: boxB })).messages).toHaveLength(0);
    await expect(sendMail(env, agent, input(boxB))).rejects.toThrow('Not found');
  });
  it('enforces read-only and send-only scopes in the service layer', async () => {
    const { env } = fixture();
    await expect(sendMail(env, { ...agent, scopes: ['read'] }, input())).rejects.toThrow(
      'send access',
    );
    await expect(listMessages(env, { ...agent, scopes: ['send'] }, {})).rejects.toThrow(
      'read access',
    );
  });
  it('rejects forged access identity and local-dev bypass on a production hostname', async () => {
    const { env } = fixture();
    await expect(
      dashboardAuth(
        new Request('https://mail.example.com/api/bootstrap', {
          headers: {
            'cf-access-authenticated-user-email': 'owner@example.net',
            'cf-access-jwt-assertion': 'forged',
          },
        }),
        env,
      ),
    ).rejects.toThrow('session has expired');
    await expect(
      dashboardAuth(new Request('https://example.workers.dev/api/bootstrap'), env),
    ).rejects.toThrow('protected Mail HQ');
  });
  it('rejects cross-origin dashboard mutations', () => {
    const { env } = fixture();
    expect(() =>
      checkOrigin(
        new Request('https://mail.example.com/api/send', {
          method: 'POST',
          headers: { origin: 'https://evil.example' },
        }),
        env,
      ),
    ).toThrow('origin');
    expect(() =>
      checkOrigin(
        new Request('https://mail.example.com/api/send', {
          method: 'POST',
          headers: { origin: env.APP_ORIGIN },
        }),
        env,
      ),
    ).not.toThrow();
  });
  it('uses hashed, expiring, immediately revocable mailbox tokens', async () => {
    const { env, sql } = fixture();
    const token = 'mhq_' + 'a'.repeat(43);
    sql
      .prepare(
        'INSERT INTO agent_tokens(id,mailbox_id,name,token_hash,prefix,scopes,expires_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        'token',
        boxA,
        'Agent',
        await hash(token),
        'mhq_aaaa',
        '["read"]',
        new Date(Date.now() + 100000).toISOString(),
      );
    const request = new Request('https://mcp.mail.example.com/mcp', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await agentAuth(request, env)).toMatchObject({ mailboxId: boxA, scopes: ['read'] });
    sql.prepare('UPDATE agent_tokens SET revoked_at=?').run(now());
    await expect(agentAuth(request, env)).rejects.toThrow('revoked');
  });
  it('only advertises permitted tools over a real MCP request', async () => {
    const { env, sql } = fixture();
    const token = 'mhq_' + 'b'.repeat(43);
    sql
      .prepare(
        'INSERT INTO agent_tokens(id,mailbox_id,name,token_hash,prefix,scopes,expires_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        'token',
        boxA,
        'Read only',
        await hash(token),
        'mhq_bbbb',
        '["read"]',
        new Date(Date.now() + 100000).toISOString(),
      );
    const request = new Request('https://mcp.mail.example.com/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const response = await handleMcp(request, env, {
      waitUntil: () => {},
    } as unknown as ExecutionContext);
    expect(response.status).toBe(200);
    const json = (await response.json()) as { result: { tools: { name: string }[] } };
    expect(json.result.tools.map((t) => t.name)).toContain('read_mail');
    expect(json.result.tools.map((t) => t.name)).not.toContain('send_mail');
  });
});
describe('safe provisioning and request validation', () => {
  it('creates managed mailboxes without account credentials and protects existing routes', async () => {
    const { env, sql } = fixture();
    sql.exec("UPDATE domains SET routing_mode='managed' WHERE name='example.com'");
    const fetch = vi.spyOn(globalThis, 'fetch');
    const data = {
      localPart: 'studio',
      domainId: '11111111111111111111111111111111',
      name: 'Studio',
      color: '#50694f',
    };
    const box = await provision(env, 'owner', data);
    expect(box.address).toBe('studio@example.com');
    expect(sql.prepare('SELECT status FROM mailboxes WHERE id=?').get(box.id)?.status).toBe(
      'active',
    );
    await expect(provision(env, 'owner', data)).rejects.toThrow('already exists');
    await expect(provision(env, 'owner', { ...data, localPart: 'hello' })).rejects.toThrow(
      'protected',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses protected existing addresses without making API calls', async () => {
    const { env } = fixture();
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(
      provision(env, 'owner', {
        localPart: 'existing',
        domainId: '11111111111111111111111111111111',
        name: 'Existing',
        color: '#123456',
      }),
    ).rejects.toThrow('protected');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses domains whose existing mail lives with another provider', async () => {
    const { env } = fixture();
    await expect(
      provision(env, 'owner', {
        localPart: 'new',
        domainId: '22222222222222222222222222222222',
        name: 'New',
        color: '#123456',
      }),
    ).rejects.toThrow('iCloud');
  });
  it('detects existing routing rules and never updates or deletes one', async () => {
    const { env } = fixture();
    env.CF_API_TOKEN = 'fixture';
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      Response.json({
        success: true,
        result: String(url).includes('dns_records')
          ? [{ content: 'route1.mx.cloudflare.net' }]
          : String(url).includes('/rules')
            ? [{ id: 'existing', matchers: [{ value: 'new@example.com' }] }]
            : { enabled: true },
      }),
    );
    await expect(
      provision(env, 'owner', {
        localPart: 'new',
        domainId: '11111111111111111111111111111111',
        name: 'New',
        color: '#123456',
      }),
    ).rejects.toThrow('already has a routing rule');
    expect(fetch.mock.calls.every((c) => !c[1]?.method || c[1].method === 'GET')).toBe(true);
  });
  it('bounds streamed bodies even without Content-Length', async () => {
    await expect(
      limitedBody(new Request('https://example.com', { method: 'POST', body: '1234567890' }), 5),
    ).rejects.toThrow('too large');
  });
  it('rejects header injection and combined recipient overflow', () => {
    expect(() =>
      sendSchema.parse({ ...input(), subject: 'hello\r\nBcc: stranger@example.com' }),
    ).toThrow();
    expect(() =>
      sendSchema.parse({
        ...input(),
        to: Array(30).fill('a@example.com'),
        cc: Array(30).fill('b@example.com'),
      }),
    ).toThrow();
  });
});
