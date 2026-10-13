import { z } from 'zod';
import { AppError, now, rateLimit, uid, type Env, type Principal } from './model';
import { requireAdmin } from './accounts';
import { configuredEnv, decryptConfig, encryptConfig } from './settings';

// Clef: $0.24 / 1M input tokens. Store integer nano-dollars at call time;
// never reprice historical usage when the rate changes.
// https://developers.cloudflare.com/workers-ai/models/clef/
const CLEF_NANO_USD_PER_INPUT_TOKEN = 240;
const usageSchema = z.object({ usage: z.object({
  input_tokens: z.number().int().nonnegative().max(1e9),
  output_tokens: z.number().int().nonnegative().max(1e9).optional(),
}) });
export async function startAiUsage(env: Env, mailboxId: string, model: string) {
  const id = uid();
  const inserted = await env.DB.prepare(`INSERT INTO ai_usage(id,owner_id,mailbox_id,model,created_at)
    SELECT ?,owner_id,id,?,? FROM mailboxes WHERE id=? RETURNING id`).bind(id, model, now(), mailboxId).first();
  if (!inserted) throw new AppError(409, 'This mailbox was removed.');
  return id;
}
export async function finishAiUsage(env: Env, id: string, response: unknown, status: 'completed' | 'failed' | 'invalid') {
  const parsed = usageSchema.safeParse(response);
  const usage = parsed.success ? parsed.data.usage : null;
  await env.DB.prepare(`UPDATE ai_usage SET status=?,input_tokens=?,output_tokens=?,cost_nano_usd=? WHERE id=?`)
    .bind(status, usage?.input_tokens ?? null, usage?.output_tokens ?? null,
      usage ? usage.input_tokens * CLEF_NANO_USD_PER_INPUT_TOKEN : null, id).run();
}

export function billingPeriod(value?: string) {
  const month = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/, 'Use a month in YYYY-MM format.').parse(value ?? now().slice(0, 7));
  if (month > now().slice(0, 7)) throw new AppError(400, 'Choose the current month or an earlier month.');
  const start = `${month}-01T00:00:00.000Z`;
  const endDate = new Date(start);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  return { month, start, end: endDate.toISOString() };
}
function account(p: Principal) {
  if (!p.userId || p.mailboxId) throw new AppError(403, 'Sign in to view account billing.');
  return p.userId;
}
export const expenseSchema = z.object({
  month: z.string(), name: z.string().trim().min(1).max(100),
  amountCents: z.number().int().min(0).max(100000000),
});
export async function addExpense(env: Env, p: Principal, input: z.infer<typeof expenseSchema>) {
  const owner = account(p), data = expenseSchema.parse(input), { month } = billingPeriod(data.month);
  await rateLimit(env, `billing-expenses:${owner}`, 30);
  const id = uid();
  await env.DB.prepare('INSERT INTO billing_expenses(id,owner_id,month,name,amount_cents,created_at) VALUES(?,?,?,?,?,?)')
    .bind(id, owner, month, data.name, data.amountCents, now()).run();
  return { id };
}
export async function deleteExpense(env: Env, p: Principal, id: string) {
  const owner = account(p);
  await env.DB.prepare('DELETE FROM billing_expenses WHERE id=? AND owner_id=?').bind(id, owner).run();
  return { ok: true };
}
export async function billingSummary(env: Env, p: Principal, month?: string) {
  const owner = account(p), period = billingPeriod(month);
  const [totals, days, expenses, metadata] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS requests,COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens,COALESCE(SUM(cost_nano_usd),0) AS costNanoUsd,
      COALESCE(SUM(cost_nano_usd IS NULL),0) AS unmeteredRequests,
      COALESCE(SUM(status IN ('failed','invalid')),0) AS failedRequests
      FROM ai_usage WHERE owner_id=? AND created_at>=? AND created_at<?`)
      .bind(owner, period.start, period.end).first<{ requests: number; inputTokens: number; outputTokens: number; costNanoUsd: number; unmeteredRequests: number; failedRequests: number }>(),
    env.DB.prepare(`SELECT substr(created_at,1,10) AS date,COUNT(*) AS requests,
      COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(cost_nano_usd),0)/1000000000.0 AS estimatedUsd
      FROM ai_usage WHERE owner_id=? AND created_at>=? AND created_at<? GROUP BY date ORDER BY date`)
      .bind(owner, period.start, period.end).all<{ date: string; requests: number; inputTokens: number; estimatedUsd: number }>(),
    env.DB.prepare('SELECT id,name,amount_cents AS amountCents FROM billing_expenses WHERE owner_id=? AND month=? ORDER BY created_at,id')
      .bind(owner, period.month).all<{ id: string; name: string; amountCents: number }>(),
    env.DB.prepare("SELECT value FROM billing_metadata WHERE key='tracking_since'").first<{ value: string }>(),
  ]);
  const { costNanoUsd, ...ai } = totals!;
  return { month: period.month, currency: 'USD', trackingSince: metadata!.value,
    ai: { ...ai, estimatedUsd: costNanoUsd / 1e9, days: days.results }, expenses: expenses.results,
    recordedTotalUsd: costNanoUsd / 1e9 + expenses.results.reduce((sum, item) => sum + item.amountCents, 0) / 100,
    canManageCloudflare: !!p.isAdmin,
    cloudflareDashboard: p.isAdmin ? `https://dash.cloudflare.com/${env.ACCOUNT_ID}/billing` : null };
}

const billingTokenKey = 'system/billing-token';
const costRowSchema = z.object({
  x_BillableMetricId: z.string(), x_ProductFamilyName: z.string().optional(),
  ChargeDescription: z.string(), BilledCost: z.number().finite().nullable().optional(),
  BillingCurrency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
});
type CostRow = z.infer<typeof costRowSchema>;
async function fetchCosts(env: Env, token: string, period: ReturnType<typeof billingPeriod>) {
  // Read-only POST: Cloudflare's restricted FOCUS cost API. No account mutations.
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/billable/usage`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Metric: 'cost', TimePeriod: { From: period.start, To: period.end } }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json() as { success?: boolean; result?: unknown };
  if (!response.ok || data.success !== true) throw new AppError(502,
    'Cloudflare did not allow billing access. Check Billing Read permission and access to its restricted cost API.');
  const parsed = z.array(costRowSchema).safeParse(data.result);
  if (!parsed.success) throw new AppError(502, 'Cloudflare returned an unsupported billing response.');
  return parsed.data;
}
export function groupCloudflareCosts(rows: CostRow[]) {
  const groups = new Map<string, { name: string; currency: string | null; amount: number | null; unrated: number }>();
  for (const row of rows) {
    const name = row.x_ProductFamilyName || row.ChargeDescription;
    const currency = row.BillingCurrency ?? null, key = JSON.stringify([name, currency]);
    const group = groups.get(key) || { name, currency, amount: null, unrated: 0 };
    if (row.BilledCost != null && currency) group.amount = (group.amount ?? 0) + row.BilledCost;
    else group.unrated++;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export async function cloudflareCosts(env: Env, p: Principal, month?: string) {
  requireAdmin(p);
  const period = billingPeriod(month);
  await rateLimit(env, `billing-provider:${account(p)}`, 30);
  try {
    const stored = await env.MAIL_STORE.get(billingTokenKey);
    const token = stored ? await decryptConfig<string>(env, billingTokenKey, await stored.text())
      : (await configuredEnv(env)).CF_API_TOKEN;
    if (!token) return { status: 'not_connected' as const, services: [], checkedAt: now() };
    const rows = await fetchCosts(env, token, period);
    // An empty response can mean this account's data source does not support costs.
    // Never present that as a zero-dollar bill.
    return { status: rows.length ? 'available' as const : 'no_data' as const,
      services: groupCloudflareCosts(rows), checkedAt: now() };
  } catch {
    return { status: 'unavailable' as const, services: [], checkedAt: now() };
  }
}
export async function saveBillingToken(env: Env, p: Principal, token: string) {
  requireAdmin(p);
  await rateLimit(env, `billing-token:${account(p)}`, 10);
  z.string().trim().min(20).max(512).regex(/^[A-Za-z0-9_-]+$/).parse(token);
  await fetchCosts(env, token, billingPeriod());
  await env.MAIL_STORE.put(billingTokenKey, await encryptConfig(env, billingTokenKey, token));
  return { ok: true };
}
export async function removeBillingToken(env: Env, p: Principal) {
  requireAdmin(p);
  await env.MAIL_STORE.delete(billingTokenKey);
  return { ok: true };
}
