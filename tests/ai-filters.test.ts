import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiFilterResults, createAiFilter, deleteAiFilter, listAiFilters, runAiFilter, updateAiFilter, updateMailboxSettings } from '../worker/src/ai-filters';
import { accountPrincipal } from '../worker/src/accounts';
import { fetchApi } from '../worker/src/index';
import type { Env, Principal } from '../worker/src/model';
import { boxA, boxB, setup } from './helpers';

let f: ReturnType<typeof setup>;
const agent: Principal = { actor: 'agent:test', mailboxId: boxA, scopes: ['read', 'admin'] };
const input = { mailboxId: boxA, name: 'Interviews', instructions: 'Actual invitations to a job interview. Exclude advice and newsletters.', folder: 'inbox' as const, threshold: 0.8 };
const ai = vi.fn(async (_model: string, data: { state: string }) => ({ answers: { matches: { type: 'noul', noul: data.state.includes('hiring manager') ? 0.98 : 0.05 } } }));
beforeEach(() => { f = setup(); ai.mockClear(); f.env.AI = { run: ai } as unknown as Env['AI']; });
afterEach(() => { f.close(); vi.restoreAllMocks(); });
async function seed(id: string, text: string, mailbox = boxA, folder = 'inbox') {
  f.sql.prepare(`INSERT INTO messages(id,mailbox_id,thread_id,direction,folder,status,sender,recipients,subject,body_key,size,created_at)
    VALUES(?,?,'thread','inbound',?,'received','sender@example.net','[]',?,?,10,'2026-10-12T12:00:00Z')`).run(id, mailbox, folder, id, `body/${id}`);
  await f.env.MAIL_STORE.put(`body/${id}`, JSON.stringify({ text }));
}

describe('saved Clef filters', () => {
  it('checks every candidate by meaning, caches decisions, resumes batches, and leaves mail untouched', async () => {
    await seed('yes', 'Could you meet our hiring manager on Thursday?');
    for (let i = 0; i < 5; i++) await seed(`no-${i}`, 'Read our interview advice newsletter.');
    await seed('other', 'Meet our hiring manager.', boxB);
    await seed('spam', 'Meet our hiring manager.', boxA, 'spam');
    const { filter } = await createAiFilter(f.env, agent, input);
    expect((await runAiFilter(f.env, agent, filter.id, 1)).stats).toMatchObject({ total: 6, checked: 4, pending: 2 });
    expect((await runAiFilter(f.env, agent, filter.id, 1)).stats).toMatchObject({ total: 6, checked: 6, pending: 0, matched: 1 });
    expect(ai).toHaveBeenCalledTimes(6);
    expect((await runAiFilter(f.env, agent, filter.id, 1)).processed).toBe(0);
    expect(ai).toHaveBeenCalledTimes(6);
    const results = await aiFilterResults(f.env, agent, filter.id);
    expect(results.messages.map(m => m.id)).toEqual(['yes']);
    expect(results.nextOffset).toBeNull();
    expect(f.sql.prepare('SELECT SUM(is_read) AS n FROM messages').get()?.n).toBe(0);
    await seed('new', 'Meet our hiring manager.');
    expect((await aiFilterResults(f.env, agent, filter.id)).stats.pending).toBe(1);
    expect((await runAiFilter(f.env, agent, filter.id, 1)).stats.matched).toBe(2);
  });
  it('requires admin for configuration and both read and admin for evaluation', async () => {
    const read = { ...agent, scopes: ['read'] } as Principal;
    const admin = { ...agent, scopes: ['admin'] } as Principal;
    const write = { ...agent, scopes: ['write'] } as Principal;
    await expect(createAiFilter(f.env, read, input)).rejects.toThrow('admin access');
    await expect(createAiFilter(f.env, write, input)).rejects.toThrow('admin access');
    const { filter } = await createAiFilter(f.env, admin, input);
    await expect(runAiFilter(f.env, admin, filter.id, 1)).rejects.toThrow('read access');
    await expect(runAiFilter(f.env, read, filter.id, 1)).rejects.toThrow('admin access');
    await expect(aiFilterResults(f.env, admin, filter.id)).rejects.toThrow('read access');
    await expect(deleteAiFilter(f.env, read, filter.id)).rejects.toThrow('admin access');
    await expect(listAiFilters(f.env, read)).rejects.toThrow('Admin access');
    expect((await aiFilterResults(f.env, read, filter.id)).filter).not.toHaveProperty('instructions');
    expect(ai).not.toHaveBeenCalled();
  });
  it('keeps filters and mailbox settings inside the connection and owning account', async () => {
    const owner = await accountPrincipal(f.env, { actor: 'owner@example.net', scopes: ['read', 'admin'] });
    const other = await accountPrincipal(f.env, { actor: 'other@example.net', scopes: ['read', 'admin'] });
    const { filter } = await createAiFilter(f.env, owner, input);
    expect((await listAiFilters(f.env, other)).filters).toEqual([]);
    await expect(aiFilterResults(f.env, other, filter.id)).rejects.toThrow('Not found');
    const foreign = { ...agent, mailboxId: boxB };
    await expect(listAiFilters(f.env, foreign, boxA)).rejects.toThrow('Not found');
    await expect(createAiFilter(f.env, foreign, input)).rejects.toThrow('Not found');
    await expect(updateAiFilter(f.env, foreign, filter.id, { ...input, version: 1 })).rejects.toThrow('Not found');
    await expect(runAiFilter(f.env, foreign, filter.id, 1)).rejects.toThrow('Not found');
    await expect(deleteAiFilter(f.env, foreign, filter.id)).rejects.toThrow('Not found');
    expect(await updateMailboxSettings(f.env, agent, { name: 'Hiring', color: '#aa00ff' })).toMatchObject({ name: 'Hiring' });
    expect(f.sql.prepare('SELECT name FROM mailboxes WHERE id=?').get(boxB)?.name).toBe('personal');
    await expect(updateMailboxSettings(f.env, { ...agent, scopes: ['read', 'write'] }, { name: 'Oops' })).rejects.toThrow('admin access');
  });
  it('invalidates matches when criteria change and rejects stale edits and in-flight decisions', async () => {
    await seed('yes', 'Meet our hiring manager.');
    const { filter } = await createAiFilter(f.env, agent, input);
    await runAiFilter(f.env, agent, filter.id, 1);
    await updateAiFilter(f.env, agent, filter.id, { ...input, instructions: 'Only receipts', version: 1 });
    expect((await aiFilterResults(f.env, agent, filter.id)).stats).toMatchObject({ checked: 0, matched: 0 });
    await expect(updateAiFilter(f.env, agent, filter.id, { ...input, version: 1 })).rejects.toThrow('changed');
    await expect(runAiFilter(f.env, agent, filter.id, 1)).rejects.toThrow('changed');
    ai.mockImplementationOnce(async () => {
      await updateAiFilter(f.env, agent, filter.id, { ...input, version: 2 });
      return { answers: { matches: { type: 'noul', noul: 0.99 } } };
    });
    await expect(runAiFilter(f.env, agent, filter.id, 2)).rejects.toThrow('changed');
    expect((await aiFilterResults(f.env, agent, filter.id)).stats.checked).toBe(0);
  });
  it('fails visibly on invalid decisions or unavailable AI without caching false negatives', async () => {
    await seed('a', 'Meet our hiring manager.');
    const { filter } = await createAiFilter(f.env, agent, input);
    ai.mockResolvedValueOnce({ answers: { matches: { type: 'noul', noul: 5 } } });
    await expect(runAiFilter(f.env, agent, filter.id, 1)).rejects.toThrow('invalid decision');
    expect((await aiFilterResults(f.env, agent, filter.id)).stats.pending).toBe(1);
    ai.mockRejectedValueOnce(new Error('provider failed'));
    await expect(runAiFilter(f.env, agent, filter.id, 1)).rejects.toThrow('could not evaluate');
    expect((await runAiFilter(f.env, agent, filter.id, 1)).stats.pending).toBe(0);
  });
  it('extracts HTML, bounds model input, reports truncation, and invalidates a changed body', async () => {
    await seed('long', '');
    await f.env.MAIL_STORE.put('body/long', JSON.stringify({ html: '<script>private script</script><p>hiring manager</p>' + 'a'.repeat(25000) }));
    const { filter } = await createAiFilter(f.env, agent, input);
    expect((await runAiFilter(f.env, agent, filter.id, 1)).stats.truncated).toBe(1);
    const payload = ai.mock.calls[0][1];
    expect(JSON.parse(payload.state).body).toHaveLength(24000);
    expect(payload.state).not.toContain('private script');
    f.sql.exec("UPDATE messages SET body_key='replacement' WHERE id='long'");
    expect((await aiFilterResults(f.env, agent, filter.id)).stats.pending).toBe(1);
  });
  it('paginates all matches and excludes spam/trash even in all-mail mode', async () => {
    for (let i = 0; i < 42; i++) await seed(`yes-${i}`, 'hiring manager');
    await seed('trash', 'hiring manager', boxA, 'trash');
    const { filter } = await createAiFilter(f.env, agent, { ...input, folder: 'all' });
    for (let i = 0; i < 11; i++) await runAiFilter(f.env, agent, filter.id, 1);
    const first = await aiFilterResults(f.env, agent, filter.id);
    const second = await aiFilterResults(f.env, agent, filter.id, first.nextOffset!);
    expect(first.stats.matched).toBe(42);
    expect(first.messages).toHaveLength(40);
    expect(second.messages).toHaveLength(2);
    expect(new Set([...first.messages, ...second.messages].map(m => m.id)).size).toBe(42);
    expect(second.nextOffset).toBeNull();
  });
  it('deletes classifications with the filter and cleans up when a mailbox is removed', async () => {
    await seed('yes', 'hiring manager');
    const { filter } = await createAiFilter(f.env, agent, input);
    await runAiFilter(f.env, agent, filter.id, 1);
    await deleteAiFilter(f.env, agent, filter.id);
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM ai_filter_results').get()?.n).toBe(0);
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(1);
    await createAiFilter(f.env, agent, input);
    f.sql.prepare('DELETE FROM messages WHERE mailbox_id=?').run(boxA);
    f.sql.prepare('DELETE FROM mailboxes WHERE id=?').run(boxA);
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM ai_filters').get()?.n).toBe(0);
  });
  it('exposes the dashboard API with origin enforcement and validates inputs', async () => {
    const call = (method: string, body: unknown, origin = 'http://localhost') => fetchApi(new Request('http://localhost/api/ai/filters', {
      method, headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), f.env, { waitUntil() {} } as unknown as ExecutionContext);
    expect((await call('POST', input, 'https://attacker.example'))?.status).toBe(403);
    expect((await call('POST', { ...input, instructions: '' }))?.status).toBe(400);
    expect((await call('POST', input))?.status).toBe(201);
  });
});
