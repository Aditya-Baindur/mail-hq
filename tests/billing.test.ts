import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountPrincipal } from '../worker/src/accounts';
import { createAiFilter, deleteAiFilter, runAiFilter } from '../worker/src/ai-filters';
import { addExpense, billingPeriod, billingSummary, cloudflareCosts, deleteExpense, finishAiUsage, groupCloudflareCosts, saveBillingToken, startAiUsage } from '../worker/src/billing';
import { fetchApi } from '../worker/src/index';
import type { Env, Principal } from '../worker/src/model';
import { boxA, boxB, setup } from './helpers';

let f: ReturnType<typeof setup>, owner: Principal, guest: Principal;
const month = '2026-10';
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
  f = setup();
  owner = await accountPrincipal(f.env, { actor: 'owner@example.net', scopes: ['read', 'write', 'admin'] });
  guest = await accountPrincipal(f.env, { actor: 'guest@example.net', scopes: ['read', 'write', 'admin'] });
  f.sql.prepare('UPDATE mailboxes SET owner_id=? WHERE id=?').run(guest.userId!, boxB);
});
afterEach(() => { f.close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const response = (tokens = 1000, probability = 0.98) => ({ usage: { input_tokens: tokens, output_tokens: 0 }, answers: { matches: { type: 'noul', noul: probability } } });
async function seed(id: string) {
  f.sql.prepare(`INSERT INTO messages(id,mailbox_id,thread_id,direction,folder,status,sender,recipients,subject,body_key,size,created_at)
    VALUES(?,?,'thread','inbound','inbox','received','sender@example.org','[]','Interview',?,10,?)`).run(id, boxA, `body/${id}`, new Date().toISOString());
  await f.env.MAIL_STORE.put(`body/${id}`, JSON.stringify({ text: 'Meet our hiring manager' }));
}
async function filter() { return (await createAiFilter(f.env, owner, { mailboxId: boxA, name: 'Interviews', instructions: 'Interview invitations', folder: 'inbox', threshold: 0.8 })).filter; }

describe('billing ledger', () => {
  it('meters real token usage precisely, ignores cache hits, and survives filter and mailbox deletion', async () => {
    await seed('mail');
    const run = vi.fn(async () => response(232)); f.env.AI = { run } as unknown as Env['AI'];
    const saved = await filter();
    await runAiFilter(f.env, owner, saved.id, 1); await runAiFilter(f.env, owner, saved.id, 1);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await billingSummary(f.env, owner, month)).ai).toMatchObject({ requests: 1, inputTokens: 232, estimatedUsd: 0.00005568, unmeteredRequests: 0 });
    await deleteAiFilter(f.env, owner, saved.id);
    f.sql.prepare('DELETE FROM messages WHERE mailbox_id=?').run(boxA);
    f.sql.prepare('DELETE FROM mailboxes WHERE id=?').run(boxA);
    expect((await billingSummary(f.env, owner, month)).ai.requests).toBe(1);
    expect((await billingSummary(f.env, guest, month)).ai.requests).toBe(0);
  });
  it('records every call in a failed batch, counts unknown usage, and charges retries separately', async () => {
    await seed('a'); await seed('b');
    const run = vi.fn().mockRejectedValueOnce(new Error('upstream failed')).mockImplementationOnce(async () => {
      await Promise.resolve(); return response(1000000);
    }).mockResolvedValue(response(100));
    f.env.AI = { run } as unknown as Env['AI'];
    const saved = await filter();
    await expect(runAiFilter(f.env, owner, saved.id, 1)).rejects.toThrow('could not evaluate');
    expect((await billingSummary(f.env, owner, month)).ai).toMatchObject({ requests: 2, estimatedUsd: 0.24, unmeteredRequests: 1, failedRequests: 1 });
    await runAiFilter(f.env, owner, saved.id, 1);
    expect((await billingSummary(f.env, owner, month)).ai).toMatchObject({ requests: 4, inputTokens: 1000200, estimatedUsd: 0.240048, unmeteredRequests: 1 });
  });
  it('records tokens even for invalid decisions and keeps interrupted calls unknown', async () => {
    await seed('a'); f.env.AI = { run: vi.fn(async () => response(500, 3)) } as unknown as Env['AI'];
    const saved = await filter();
    await expect(runAiFilter(f.env, owner, saved.id, 1)).rejects.toThrow('invalid decision');
    await startAiUsage(f.env, boxA, '@cf/cloudflare/clef');
    const id = await startAiUsage(f.env, boxA, '@cf/cloudflare/clef');
    await finishAiUsage(f.env, id, { usage: { input_tokens: -1 } }, 'completed');
    expect((await billingSummary(f.env, owner, month)).ai).toMatchObject({ requests: 3, inputTokens: 500, estimatedUsd: 0.00012, unmeteredRequests: 2, failedRequests: 1 });
    await expect(startAiUsage(f.env, 'deleted', '@cf/cloudflare/clef')).rejects.toThrow('removed');
  });
  it('uses UTC month boundaries and never leaks or deletes another account’s expenses', async () => {
    const entry = await addExpense(f.env, owner, { month, name: 'Mail server', amountCents: 500 });
    await addExpense(f.env, guest, { month, name: 'Private renewal', amountCents: 1200 });
    await addExpense(f.env, owner, { month: '2026-09', name: 'Earlier', amountCents: 600 });
    vi.setSystemTime(new Date('2026-09-30T23:59:59Z'));
    const before = await startAiUsage(f.env, boxA, '@cf/cloudflare/clef'); await finishAiUsage(f.env, before, response(1000000), 'completed');
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const after = await startAiUsage(f.env, boxA, '@cf/cloudflare/clef'); await finishAiUsage(f.env, after, response(2000000), 'completed');
    await deleteExpense(f.env, guest, entry.id);
    const data = await billingSummary(f.env, owner, month);
    expect(data.recordedTotalUsd).toBe(5.48);
    expect(data.expenses.map(e => e.name)).toEqual(['Mail server']);
    expect(data.ai.days[0].date).toBe('2026-10-01');
    expect((await billingSummary(f.env, owner, '2026-09')).recordedTotalUsd).toBe(6.24);
    await deleteExpense(f.env, owner, entry.id);
    expect((await billingSummary(f.env, owner, month)).expenses).toEqual([]);
    await expect(billingSummary(f.env, { ...owner, mailboxId: boxA }, month)).rejects.toThrow('Sign in');
  });
  it('validates monetary inputs and month ranges before writing or calling providers', async () => {
    for (const invalid of ['2026-13', '2026-00', '2026-11', "2026-01' OR 1=1"]) expect(() => billingPeriod(invalid)).toThrow();
    expect(billingPeriod('2024-02')).toMatchObject({ start: '2024-02-01T00:00:00.000Z', end: '2024-03-01T00:00:00.000Z' });
    for (const amountCents of [-1, 1.1, Infinity, 100000001]) await expect(addExpense(f.env, owner, { month, name: 'Bad', amountCents })).rejects.toThrow();
    expect((await billingSummary(f.env, owner, month)).expenses).toEqual([]);
  });
  it('serves billing with no-store and applies origin checks to mutations', async () => {
    const ctx = { waitUntil() {} } as unknown as ExecutionContext;
    const read = await fetchApi(new Request(`http://localhost/api/billing?month=${month}`), f.env, ctx);
    expect(read?.status).toBe(200); expect(read?.headers.get('cache-control')).toBe('no-store');
    const write = await fetchApi(new Request('http://localhost/api/billing/expenses', { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: JSON.stringify({ month, name: 'Bad', amountCents: 10 }) }), f.env, ctx);
    expect(write?.status).toBe(403);
  });
});

describe('Cloudflare billing integration', () => {
  const row = { x_BillableMetricId: 'workers_requests', x_ProductFamilyName: 'Workers', ChargeDescription: 'Requests', BilledCost: 0.5, BillingCurrency: 'USD' };
  it('restricts shared billing and credentials to the app owner, not MCP admin scopes', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(cloudflareCosts(f.env, guest, month)).rejects.toThrow('Only the app owner');
    await expect(saveBillingToken(f.env, guest, 'x'.repeat(30))).rejects.toThrow('Only the app owner');
    await expect(cloudflareCosts(f.env, { actor: 'agent', mailboxId: boxA, scopes: ['admin'] }, month)).rejects.toThrow('Only the app owner');
    expect(fetch).not.toHaveBeenCalled();
    expect(await cloudflareCosts(f.env, owner, month)).toMatchObject({ status: 'not_connected' });
  });
  it('keeps currencies separate, preserves credits, and marks absent pricing as unknown', () => {
    expect(groupCloudflareCosts([row, { ...row, BilledCost: -0.1 }, { ...row, BilledCost: null }, { ...row, BilledCost: 2, BillingCurrency: 'CAD' }])).toEqual([
      { name: 'Workers', currency: 'USD', amount: 0.4, unrated: 1 },
      { name: 'Workers', currency: 'CAD', amount: 2, unrated: 0 },
    ]);
    expect(groupCloudflareCosts([{ ...row, BillingCurrency: null }])[0]).toMatchObject({ amount: null, unrated: 1 });
  });
  it('distinguishes zero charges, empty responses and provider failures without leaking credentials', async () => {
    f.env.CF_API_TOKEN = 'private-provisioning-token';
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ success: true, result: [{ ...row, BilledCost: 0 }] }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [] }))
      .mockResolvedValueOnce(Response.json({ success: false, errors: [{ message: 'private-provisioning-token' }] }, { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    const data = await cloudflareCosts(f.env, owner, month);
    expect(data).toMatchObject({ status: 'available', services: [{ amount: 0 }] });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ Metric: 'cost', TimePeriod: { From: '2026-10-01T00:00:00.000Z', To: '2026-11-01T00:00:00.000Z' } });
    expect(await cloudflareCosts(f.env, owner, month)).toMatchObject({ status: 'no_data' });
    const failure = await cloudflareCosts(f.env, owner, month);
    expect(failure).toMatchObject({ status: 'unavailable' }); expect(JSON.stringify(failure)).not.toContain('private-provisioning-token');
  });
  it('validates billing tokens before saving encrypted data without replacing provisioning credentials', async () => {
    f.env.CONFIG_ENCRYPTION_KEY = btoa('k'.repeat(32));
    const token = 'billing_read_token_1234567890';
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ success: true, result: [row] }))
      .mockResolvedValueOnce(Response.json({ success: false }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [row] }));
    vi.stubGlobal('fetch', fetch);
    await f.env.MAIL_STORE.put('system/provisioning-token', 'untouched');
    await saveBillingToken(f.env, owner, token);
    const encrypted = await (await f.env.MAIL_STORE.get('system/billing-token'))!.text();
    expect(encrypted).not.toContain(token);
    await expect(saveBillingToken(f.env, owner, 'bad_token_1234567890123456')).rejects.toThrow('did not allow');
    expect(await (await f.env.MAIL_STORE.get('system/billing-token'))!.text()).toBe(encrypted);
    expect(await (await f.env.MAIL_STORE.get('system/provisioning-token'))!.text()).toBe('untouched');
    expect((await cloudflareCosts(f.env, owner, month)).status).toBe('available');
    expect(fetch.mock.calls[2][1].headers.Authorization).toBe(`Bearer ${token}`);
  });
});
