import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup, boxA, boxB } from './helpers';
import { listMessages, receiveEmail, sendMail, sendSchema } from '../worker/src/mail';
import { backfillSearchBatch, htmlSearchText, messageSearchStatements, SEARCH_CHUNK_LENGTH, searchChunks } from '../worker/src/search';
import { createMailPassword, handleBridge } from '../worker/src/bridge';
import { fetchApi } from '../worker/src/index';
import { handleMcp } from '../worker/src/mcp';
import type { Principal } from '../worker/src/model';

let f: ReturnType<typeof setup>;
const owner: Principal = { actor: 'test', scopes: ['read', 'send'] };
const agent: Principal = { actor: 'agent:test', mailboxId: boxA, scopes: ['read'] };
const prefix = 'This is the preview. '.repeat(30);
beforeEach(() => { f = setup(); });
afterEach(() => { f.close(); vi.restoreAllMocks(); });
async function receive(text: string, options: { recipient?: string; html?: boolean; id?: string } = {}) {
  const recipient = options.recipient || 'research@example.com';
  const raw = `From: Alice <alice@example.net>\r\nTo: ${recipient}\r\nSubject: Ordinary subject\r\nMessage-ID: <${options.id || crypto.randomUUID()}@example.net>\r\nMIME-Version: 1.0\r\nContent-Type: text/${options.html ? 'html' : 'plain'}; charset=utf-8\r\n\r\n${text}`;
  await receiveEmail({ from: 'alice@example.net', to: recipient, rawSize: new TextEncoder().encode(raw).length,
    raw: new Blob([raw]).stream(), setReject: vi.fn() } as unknown as ForwardableEmailMessage, f.env);
}
function legacy(id: string, body?: object) {
  const key = `legacy/${id}/body.json`;
  f.sql.prepare(`INSERT INTO messages(id,mailbox_id,thread_id,direction,sender,subject,snippet,body_key,created_at)
    VALUES(?,?,?,'inbound','sender@example.net','Old subject','Old preview',?,'2026-10-01')`).run(id, boxA, id, key);
  if (body) f.objects.set(key, new TextEncoder().encode(JSON.stringify(body)));
  return key;
}

describe('full-message search', () => {
  it('finds text beyond the preview without reading R2 during search', async () => {
    await receive(prefix + 'The launch codename is Starling Orchid.');
    const get = vi.spyOn(f.env.MAIL_STORE, 'get').mockRejectedValue(new Error('Search must not fetch R2'));
    const result = await listMessages(f.env, agent, { q: 'starling orchid' });
    expect(result.total).toBe(1);
    expect(result.messages[0].snippet).not.toContain('Starling');
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('launch codename');
  });
  it('extracts HTML entities and inline words while excluding scripts and styles', async () => {
    const html = '<head><style>secretcssneedle</style></head><p>Launch <b>Star</b>ling &amp; &#x4f;rchid</p><script>scriptsentinel</script><img alt="Diagram legend" src="https://example.net/tracker"><p>Next paragraph</p>';
    expect(htmlSearchText(html)).toBe('Launch Starling & Orchid Diagram legend Next paragraph');
    await receive(prefix + html, { html: true });
    expect((await listMessages(f.env, agent, { q: 'Starling & Orchid' })).total).toBe(1);
    expect((await listMessages(f.env, agent, { q: 'secretcssneedle' })).total).toBe(0);
    expect((await listMessages(f.env, agent, { q: 'scriptsentinel' })).total).toBe(0);
    expect((await listMessages(f.env, agent, { q: 'Diagram legend' })).total).toBe(1);
    expect((await listMessages(f.env, agent, { q: 'https://example.net/tracker' })).total).toBe(0);
  });
  it('indexes both multipart representations, including HTML beyond a placeholder text part', async () => {
    const key = legacy('both', { text: 'Plain alternative', html: '<p>HTML alternative with octopus</p>' });
    await backfillSearchBatch(f.env);
    expect((await listMessages(f.env, agent, { q: 'octopus' })).total).toBe(1);
    expect((await listMessages(f.env, agent, { q: 'Plain alternative' })).total).toBe(1);
    expect(f.objects.has(key)).toBe(true);
  });
  it('preserves literal punctuation, quotes, substrings and short queries', async () => {
    await receive(prefix + 'Budget 100% complete; ticket AB_42; say "Hello"; quokka@example.net; xy; café');
    for (const q of ['100%', 'AB_42', '"Hello"', 'uokka@', 'xy', 'CAFÉ']) {
      expect((await listMessages(f.env, agent, { q })).total, q).toBe(1);
    }
    for (const q of ['100_', 'AB%42', '" OR *', 'text:quokka', "x' UNION SELECT * FROM messages --"]) {
      expect((await listMessages(f.env, agent, { q })).total, q).toBe(0);
    }
    expect((await listMessages(f.env, agent, { q: '   ' })).total).toBe(1);
  });
  it('keeps results and counts scoped to the assigned mailbox and selected folder', async () => {
    await receive(prefix + 'crossmailboxneedle');
    await receive(prefix + 'crossmailboxneedle', { recipient: 'personal@example.com' });
    expect((await listMessages(f.env, owner, { q: 'crossmailboxneedle' })).total).toBe(2);
    const scoped = await listMessages(f.env, agent, { q: 'crossmailboxneedle', mailboxId: boxB });
    expect(scoped.total).toBe(1);
    expect(scoped.messages.every(m => m.mailbox_id === boxA)).toBe(true);
    f.sql.prepare("UPDATE messages SET folder='trash' WHERE mailbox_id=?").run(boxA);
    expect((await listMessages(f.env, agent, { q: 'crossmailboxneedle' })).total).toBe(0);
    expect((await listMessages(f.env, agent, { q: 'crossmailboxneedle', folder: 'trash' })).total).toBe(1);
    await expect(listMessages(f.env, { ...agent, scopes: ['send'] }, { q: 'needle' })).rejects.toThrow('read access');
  });
  it('supports bodies larger than a D1 row, including matches across chunk boundaries', async () => {
    const key = legacy('large');
    const needle = 'Boundary🦊needle';
    const text = 'x'.repeat(SEARCH_CHUNK_LENGTH - 6) + needle + 'y'.repeat(2_100_000) + ' Farendneedle';
    await f.env.DB.batch(messageSearchStatements(f.env, 'large', key, { text }));
    expect((await listMessages(f.env, agent, { q: needle })).total).toBe(1);
    expect((await listMessages(f.env, agent, { q: 'Farendneedle' })).total).toBe(1);
    const chunks = [...searchChunks('a'.repeat(SEARCH_CHUNK_LENGTH - 1) + '🦊'.repeat(150) + 'tail')];
    expect(chunks.every(c => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(c))).toBe(true);
    expect(chunks.every(c => new TextEncoder().encode(c).length < 2_000_000)).toBe(true);
  });
  it('deduplicates matches and preserves total counts while paginating', async () => {
    for (const id of ['one', 'two', 'three']) {
      const key = legacy(id);
      await f.env.DB.batch(messageSearchStatements(f.env, id, key, { text: ('paginationneedle '.repeat(7000)) }));
    }
    const first = await listMessages(f.env, agent, { q: 'paginationneedle', limit: 2 });
    expect(first.total).toBe(3);
    expect(first.messages).toHaveLength(2);
    const second = await listMessages(f.env, agent, { q: 'paginationneedle', limit: 2, cursor: first.nextCursor! });
    expect(second.total).toBe(3);
    expect(second.messages).toHaveLength(1);
    expect(new Set([...first.messages, ...second.messages].map(m => m.id)).size).toBe(3);
  });
  it('keeps metadata updates and message deletion synchronized with FTS', async () => {
    const key = legacy('mutable');
    await f.env.DB.batch(messageSearchStatements(f.env, 'mutable', key, { text: 'immutablebodyneedle' }));
    f.sql.prepare('UPDATE messages SET subject=? WHERE id=?').run('Revised subject', 'mutable');
    expect((await listMessages(f.env, agent, { q: 'Old subject' })).total).toBe(0);
    expect((await listMessages(f.env, agent, { q: 'Revised subject' })).total).toBe(1);
    f.sql.prepare('DELETE FROM messages WHERE id=?').run('mutable');
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM message_search_state').get()?.n).toBe(0);
    expect(f.sql.prepare("SELECT COUNT(*) AS n FROM message_search_fts WHERE message_search_fts MATCH 'immutablebodyneedle'").get()?.n).toBe(0);
  });
  it('indexes new sent mail in the same transaction and retains idempotency', async () => {
    const input = sendSchema.parse({ mailboxId: boxA, to: ['friend@example.net'], subject: 'Sent subject', text: prefix + 'outboundbodyneedle', idempotencyKey: crypto.randomUUID() });
    await sendMail(f.env, owner, input);
    await sendMail(f.env, owner, input);
    expect((await listMessages(f.env, agent, { folder: 'sent', q: 'outboundbodyneedle' })).total).toBe(1);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM message_search_state').get()?.n).toBe(1);
  });
  it('does not send or persist a partial message when indexing fails', async () => {
    f.sql.exec("CREATE TRIGGER fail_search BEFORE INSERT ON message_search_chunks WHEN new.part>0 BEGIN SELECT RAISE(ABORT,'test failure'); END");
    const input = sendSchema.parse({ mailboxId: boxA, to: ['friend@example.net'], subject: 'Test', text: 'Body', idempotencyKey: crypto.randomUUID() });
    await expect(sendMail(f.env, owner, input)).rejects.toThrow('test failure');
    expect(f.send).not.toHaveBeenCalled();
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(0);
    expect(f.objects.size).toBe(0);
  });
  it('indexes Apple Mail APPEND without sending an email', async () => {
    f.env.BRIDGE_HOST = 'bridge.example.com'; f.env.BRIDGE_API_SECRET = 'test-only';
    const login = await createMailPassword(f.env, 'test', { mailboxId: boxA, name: 'Test' });
    const raw = btoa(`From: research@example.com\r\nTo: friend@example.net\r\nSubject: Saved message\r\n\r\n${prefix}applebodyneedle`);
    const response = await handleBridge(new Request('https://mcp.example.com/bridge/v1', { method: 'POST', headers: {
      authorization: `Basic ${btoa(`${login.address}:${login.password}`)}`, 'x-mailhq-bridge': 'test-only',
    }, body: JSON.stringify({ action: 'append', folder: 'inbox', raw, flags: [], date: '2026-10-08T12:00:00.000Z' }) }), f.env);
    expect(response.status).toBe(200);
    expect((await listMessages(f.env, agent, { q: 'applebodyneedle' })).total).toBe(1);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('exposes full-body search through the dashboard API and MCP list_mail', async () => {
    await receive(prefix + 'surfacebodyneedle');
    const ctx = { waitUntil() {} } as unknown as ExecutionContext;
    const response = await fetchApi(new Request('http://localhost/api/messages?q=surfacebodyneedle'), f.env, ctx);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ total: 1 });
    const result = await handleMcp(new Request('https://mcp.mail.example.com/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_mail', arguments: { query: 'surfacebodyneedle' } } }) }), f.env, ctx, agent);
    const rpc = await result.json() as { result: { content: { text: string }[] } };
    expect(JSON.parse(rpc.result.content[0].text)).toMatchObject({ total: 1 });
  });
  it('finds deep body matches in every folder through the global API and scoped MCP search', async () => {
    for (const folder of ['inbox', 'sent', 'archive', 'trash', 'spam']) {
      const id = `global-${folder}`;
      const key = legacy(id);
      f.sql.prepare('UPDATE messages SET folder=?, mailbox_id=? WHERE id=?').run(folder, folder === 'inbox' ? boxB : boxA, id);
      await f.env.DB.batch(messageSearchStatements(f.env, id, key, { text: prefix + 'everyfolderneedle' }));
    }
    const ctx = { waitUntil() {} } as unknown as ExecutionContext;
    const response = await fetchApi(new Request('http://localhost/api/messages?folder=all&q=everyfolderneedle'), f.env, ctx);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ total: 5 });
    const call = async (args: object) => {
      const result = await handleMcp(new Request('https://mcp.mail.example.com/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_mail', arguments: args } }) }), f.env, ctx, agent);
      const rpc = await result.json() as { result: { content: { text: string }[] } };
      return JSON.parse(rpc.result.content[0].text);
    };
    const result = await call({ query: 'everyfolderneedle' });
    expect(result.total).toBe(4);
    expect(result.messages.every((m: { mailbox_id: string }) => m.mailbox_id === boxA)).toBe(true);
    expect(await call({ query: 'everyfolderneedle', folder: 'trash' })).toMatchObject({ total: 1 });
    expect(await call({ query: 'everyfolderneedle', folder: 'all' })).toMatchObject({ total: 4 });
    expect(await call({})).toMatchObject({ total: 0 });
  });
});

describe('existing-mail backfill', () => {
  it('resumes in bounded batches, retries missing bodies and preserves original storage', async () => {
    legacy('a', { text: prefix + 'historicalbodyneedle' });
    const missing = legacy('b');
    legacy('c', { html: '<p>HTML history needle</p>' });
    const before = new Map(f.objects);
    const first = await backfillSearchBatch(f.env, '', 2);
    expect(first).toMatchObject({ indexed: 1, failed: [{ id: 'b', reason: 'missing_body' }], cursor: 'b' });
    const second = await backfillSearchBatch(f.env, first.cursor!, 2);
    expect(second).toMatchObject({ indexed: 1, failed: [], cursor: 'c' });
    expect(await backfillSearchBatch(f.env, second.cursor!, 2)).toMatchObject({ indexed: 0, cursor: null });
    expect(f.objects).toEqual(before);
    f.objects.set(missing, new TextEncoder().encode(JSON.stringify({ text: 'Recovered history' })));
    expect(await backfillSearchBatch(f.env)).toMatchObject({ indexed: 1, failed: [] });
    expect(await backfillSearchBatch(f.env)).toMatchObject({ indexed: 0, failed: [] });
    expect((await listMessages(f.env, agent, { q: 'historicalbodyneedle' })).total).toBe(1);
    expect((await listMessages(f.env, agent, { q: 'HTML history needle' })).total).toBe(1);
    expect((await listMessages(f.env, agent, { q: 'Recovered history' })).total).toBe(1);
  });
  it('invalidates stale bodies and reindexes a changed source', async () => {
    legacy('a', { text: 'Originalbodyneedle' });
    await backfillSearchBatch(f.env);
    f.sql.prepare('UPDATE messages SET body_key=? WHERE id=?').run('replacement', 'a');
    expect((await listMessages(f.env, agent, { q: 'Originalbodyneedle' })).total).toBe(0);
    f.objects.set('replacement', new TextEncoder().encode(JSON.stringify({ text: 'Replacementbodyneedle' })));
    await backfillSearchBatch(f.env);
    expect((await listMessages(f.env, agent, { q: 'Replacementbodyneedle' })).total).toBe(1);
  });
});
