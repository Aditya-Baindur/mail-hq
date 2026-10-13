'use client';
import { useEffect, useState } from 'react';
import { CreditCard, ExternalLink, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { api, ErrorNote, Spinner } from './shared';
import type { billingSummary, cloudflareCosts } from '../worker/src/billing';

type BillingData = Awaited<ReturnType<typeof billingSummary>>;
type ProviderData = Awaited<ReturnType<typeof cloudflareCosts>>;
export function money(amount: number, currency = 'USD') {
  if (amount > 0 && amount < 0.000001) return `<${new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 6 }).format(0.000001)}`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2,
    maximumFractionDigits: amount !== 0 && Math.abs(amount) < 0.01 ? 6 : 2 }).format(amount);
}
const services = [
  ['Workers hosting', '$5/month on Workers Paid; requests and CPU overages extra.', 'workers/platform/pricing/'],
  ['D1 database', 'Paid: 25B rows read, 50M written and 5 GB included monthly. Overages: $0.001/M reads, $1/M writes, $0.75/GB-month.', 'd1/platform/pricing/'],
  ['R2 storage', 'Standard: 10 GB-month, 1M writes/lists and 10M reads included. Overages: $0.015/GB-month, $4.50/M writes/lists, $0.36/M reads.', 'r2/pricing/'],
  ['KV authentication', 'Paid: 10M reads, 1M each writes/deletes/lists and 1 GB included monthly. Overages: $0.50/M reads, $5/M each other operation, $0.50/GB-month.', 'kv/platform/pricing/'],
  ['Email delivery', '3,000 outbound emails included per month on Workers Paid, then $0.35/1,000. Inbound routing is free; Worker execution is billed separately.', 'email-service/platform/pricing/'],
] as const;

export function Billing() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<BillingData | null>(null);
  const [provider, setProvider] = useState<ProviderData | null>(null);
  const [error, setError] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [token, setToken] = useState('');
  const [tokenNotice, setTokenNotice] = useState('');
  const refresh = () => setRevision(value => value + 1);
  useEffect(() => {
    let cancelled = false;
    setData(null); setProvider(null); setError('');
    api<BillingData>(`/billing?month=${month}`).then(async value => {
      if (cancelled) return;
      setData(value);
      if (value.canManageCloudflare) {
        try {
          const costs = await api<ProviderData>(`/billing/cloudflare?month=${month}`);
          if (!cancelled) setProvider(costs);
        } catch {
          if (!cancelled) setProvider({ status: 'unavailable', services: [], checkedAt: new Date().toISOString() });
        }
      }
    })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [month, revision]);
  async function mutate(operation: () => Promise<unknown>, after?: () => void) {
    setBusy(true); setMutationError('');
    try { await operation(); after?.(); refresh(); }
    catch (e) { setMutationError(e instanceof Error ? e.message : 'Could not save this change.'); }
    finally { setBusy(false); }
  }
  const monthEnd = new Date(`${month}-01T00:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  const hasHistory = data && monthEnd > new Date(data.trackingSince);
  return <section className="billing-section" aria-labelledby="billing-heading">
    <div className="chart-heading billing-heading">
      <div><h2 id="billing-heading"><CreditCard size={19} /> Billing</h2><p>AI usage and running costs · USD</p></div>
      <div className="billing-controls">
        <label htmlFor="billing-month">Month (UTC)</label>
        <Input id="billing-month" type="month" min="2000-01" max={new Date().toISOString().slice(0, 7)} value={month} disabled={busy}
          onChange={e => { if (e.target.value) { setMonth(e.target.value); setMutationError(''); } }} />
        <Button size="sm" variant="outline" onClick={refresh} disabled={busy} aria-label="Refresh billing"><RefreshCw size={15} /></Button>
      </div>
    </div>
    <ErrorNote message={error} />
    {!data ? <div className="billing-loading">{error ? <Button variant="outline" onClick={refresh}>Retry billing</Button> : <><Spinner /> Loading costs…</>}</div> : <>
      <div className="metric-grid billing-metrics">
        <div className="metric-card"><span>Recorded cost estimate <CreditCard size={17} /></span>
          <strong>{hasHistory || data.expenses.length ? money(data.recordedTotalUsd) : 'No history'}</strong><small>Measured AI + expenses you record{data.ai.unmeteredRequests > 0 ? ' · incomplete' : ''}</small></div>
        <div className="metric-card"><span>AI at list price <Sparkles size={17} /></span>
          <strong>{data.ai.unmeteredRequests > 0 && data.ai.unmeteredRequests === data.ai.requests ? 'Unknown' : hasHistory ? money(data.ai.estimatedUsd) : 'No history'}</strong><small>Before Cloudflare’s shared free allowance</small></div>
        <div className="metric-card"><span>AI input tokens</span><strong>{data.ai.inputTokens.toLocaleString()}</strong>
          <small>{data.ai.requests.toLocaleString()} inference attempts · cached matches use no AI</small></div>
      </div>
      <p className="billing-note">AI tracking started {new Date(data.trackingSince).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })}. Earlier scans aren’t included.
        {' '}Clef costs <a href="https://developers.cloudflare.com/workers-ai/models/clef/" target="_blank" rel="noreferrer">$0.24 per million input tokens</a>.
        {' '}Cloudflare includes <a href="https://developers.cloudflare.com/workers-ai/platform/pricing/" target="_blank" rel="noreferrer">10,000 AI neurons daily</a> across your Cloudflare account; your billed AI cost may be lower.</p>
      {data.ai.unmeteredRequests > 0 && <p className="billing-warning" role="status">Cost is incomplete: {data.ai.unmeteredRequests} attempt(s) did not return token usage. Their cost is unknown.</p>}
      {data.ai.failedRequests > 0 && <p className="billing-note">{data.ai.failedRequests} failed or invalid inference(s). Any returned token usage is included above.</p>}
      {data.ai.days.length > 0 && <details className="billing-details"><summary>Daily AI usage</summary><div className="billing-table-wrap"><table className="billing-table">
        <thead><tr><th scope="col">Day (UTC)</th><th scope="col">Attempts</th><th scope="col">Input tokens</th><th scope="col">List-price estimate</th></tr></thead>
        <tbody>{data.ai.days.map(day => <tr key={day.date}><td>{day.date}</td><td>{day.requests.toLocaleString()}</td><td>{day.inputTokens.toLocaleString()}</td><td>{money(day.estimatedUsd)}</td></tr>)}</tbody>
      </table></div></details>}

      <div className="billing-expenses">
        <h3>Other recorded expenses</h3><p className="billing-note">Add hosting, a domain renewal, a mail server, or an invoice charge for this month. These are manual entries in USD. Skip AI usage already tracked above.</p>
        {data.expenses.length ? <ul className="billing-expense-list">{data.expenses.map(expense => <li key={expense.id}>
          <span>{expense.name}<small>Manual entry</small></span><strong>{money(expense.amountCents / 100)}</strong>
          <Button size="sm" variant="ghost" aria-label={`Remove ${expense.name}`} disabled={busy} onClick={() => void mutate(() => api(`/billing/expenses/${expense.id}`, { method: 'DELETE' }))}><Trash2 size={15} /></Button>
        </li>)}</ul> : <p className="billing-empty">No other expenses recorded for this month.</p>}
        <form className="billing-expense-form" onSubmit={e => { e.preventDefault();
          const cents = Math.round(Number(amount) * 100);
          if (!/^\d+(\.\d{1,2})?$/.test(amount) || !Number.isSafeInteger(cents)) { setMutationError('Enter a USD amount with at most two decimal places.'); return; }
          void mutate(() => api('/billing/expenses', { method: 'POST', body: JSON.stringify({ month, name, amountCents: cents }) }), () => { setName(''); setAmount(''); });
        }}>
          <label>Expense<Input placeholder="e.g. Mail server" value={name} maxLength={100} required disabled={busy} onChange={e => setName(e.target.value)} /></label>
          <label>Amount (USD)<Input type="number" inputMode="decimal" min="0" max="1000000" step="0.01" placeholder="5.00" value={amount} required disabled={busy} onChange={e => setAmount(e.target.value)} /></label>
          <Button variant="outline" disabled={busy}><Plus size={15} /> Add expense</Button>
        </form>
      </div>

      {data.canManageCloudflare && <div className="billing-provider">
        <div className="chart-heading"><div><h3>Cloudflare account charges</h3><p>All apps in the hosting account · metered charges reported by Cloudflare</p></div>
          <a className="billing-provider-link" href={data.cloudflareDashboard!} target="_blank" rel="noreferrer">Open billing <ExternalLink size={14} /></a></div>
        {!provider ? <p className="billing-note"><Spinner /> Checking Cloudflare…</p> : provider.status === 'available' ? <>
          <div className="billing-table-wrap"><table className="billing-table"><thead><tr><th scope="col">Service</th><th scope="col">Reported charge</th></tr></thead>
            <tbody>{provider.services.map(service => <tr key={`${service.name}-${service.currency}`}><td>{service.name}</td>
              <td>{service.amount === null ? 'Unknown' : `${money(service.amount, service.currency!)} ${service.currency}`}{service.unrated > 0 && <small> · incomplete pricing</small>}</td></tr>)}</tbody></table></div>
          <p className="billing-note">Provider data can lag. This includes other projects and may include the AI shown above, so it is separate from your recorded total. Subscription fees, taxes, and invoice adjustments may be absent. Check Cloudflare for the final invoice.</p>
        </> : <p className="billing-warning">{provider.status === 'no_data' ? 'Cloudflare returned no cost records for this month.' : provider.status === 'not_connected' ? 'Cloudflare billing is not connected.' : 'Cloudflare account charges are unavailable with the current connection.'} Hosting, database, storage, authentication, and email charges are unknown until Cloudflare returns them or you record an expense.</p>}
        <details className="billing-details"><summary>Connect billing access</summary>
          <p className="billing-note">Use a Cloudflare API token with Billing Read access to this hosting account. Cloudflare’s cost API is restricted and may require account eligibility. The token is encrypted and is used only to read costs. Your existing provisioning connection is tried when no billing token is saved.</p>
          <form className="billing-token-form" onSubmit={e => { e.preventDefault(); setTokenNotice(''); void mutate(() => api('/billing/cloudflare-token', { method: 'PUT', body: JSON.stringify({ token }) }), () => { setToken(''); setTokenNotice('Billing connection saved.'); }); }}>
            <label>Billing API token<Input type="password" autoComplete="off" value={token} required minLength={20} maxLength={512} disabled={busy} onChange={e => setToken(e.target.value)} /></label>
            <Button variant="outline" disabled={busy}>Connect</Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void mutate(() => api('/billing/cloudflare-token', { method: 'DELETE' }), () => { setToken(''); setTokenNotice('Billing token removed. Using the provisioning connection if available.'); })}>Remove saved token</Button>
          </form><p role="status" className="billing-note">{tokenNotice}</p>
        </details>
      </div>}
      <details className="billing-details"><summary>Hosting, storage & email pricing</summary>
        <p className="billing-note">Reference rates checked October 12, 2026. Allowances are shared across the Cloudflare account. These rates are not added to your total automatically; usage, subscription cycles, rounding, and plan changes affect the final bill.</p>
        <ul className="billing-rate-list">{services.map(([title, description, path]) => <li key={title}><a href={`https://developers.cloudflare.com/${path}`} target="_blank" rel="noreferrer">{title} <ExternalLink size={12} /></a><p>{description}</p></li>)}</ul>
      </details>
      <ErrorNote message={mutationError} />
    </>}
  </section>;
}
