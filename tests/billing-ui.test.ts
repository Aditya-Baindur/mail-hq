// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Billing, money } from '../components/billing';

let root: Root, host: HTMLDivElement;
let isAdmin: boolean, unknown: number;
let expenses: { id: string; name: string; amountCents: number }[];
let calls: { path: string; month: string | null; method: string; body: Record<string, unknown> }[];
const currentMonth = new Date().toISOString().slice(0, 7);
beforeEach(() => {
  isAdmin = true; unknown = 0; expenses = []; calls = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const request = new URL(url, 'http://localhost'), method = init?.method || 'GET', body = JSON.parse(String(init?.body || '{}'));
    calls.push({ path: request.pathname, month: request.searchParams.get('month'), method, body });
    if (request.pathname === '/api/billing/cloudflare') return Response.json({ status: 'unavailable', services: [], checkedAt: new Date().toISOString() });
    if (method === 'POST') { expenses.push({ id: 'expense', name: body.name, amountCents: body.amountCents }); return Response.json({ id: 'expense' }); }
    if (method === 'DELETE') { expenses = []; return Response.json({ ok: true }); }
    return Response.json({ month: request.searchParams.get('month'), currency: 'USD', trackingSince: `${currentMonth}-01T00:00:00Z`,
      ai: { requests: 1, inputTokens: 232, outputTokens: 0, estimatedUsd: 0.00005568, unmeteredRequests: unknown, failedRequests: 0, days: [] },
      expenses, recordedTotalUsd: 0.00005568 + expenses.reduce((sum, expense) => sum + expense.amountCents / 100, 0), canManageCloudflare: isAdmin, cloudflareDashboard: 'https://dash.cloudflare.com/test/billing' });
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(createElement(Billing))); }
async function input(element: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
describe('billing UI', () => {
  it('shows tiny AI costs without rounding to zero and distinguishes unavailable Cloudflare costs', async () => {
    await render();
    expect(host.textContent).toContain('$0.000056');
    expect(host.textContent).toContain('charges are unavailable');
    expect(host.textContent).toContain('charges are unknown');
    expect(money(0.00000001)).toBe('<$0.000001');
    expect(host.querySelector('a[href="https://dash.cloudflare.com/test/billing"]')).not.toBeNull();
  });
  it('records expenses in cents for the chosen month and updates totals after removal', async () => {
    await render();
    const inputs = host.querySelectorAll<HTMLInputElement>('.billing-expense-form input');
    await input(inputs[0], 'Mail server'); await input(inputs[1], '5.25');
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(calls.find(call => call.method === 'POST')?.body).toEqual({ month: currentMonth, name: 'Mail server', amountCents: 525 });
    expect(host.querySelector('.billing-expense-list')?.textContent).toContain('$5.25');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Remove Mail server"]')!.click());
    expect(host.textContent).toContain('No other expenses recorded');
    const earlier = new Date(); earlier.setUTCDate(1); earlier.setUTCMonth(earlier.getUTCMonth() - 1);
    await input(host.querySelector<HTMLInputElement>('#billing-month')!, earlier.toISOString().slice(0, 7));
    expect(calls.filter(call => call.path === '/api/billing').at(-1)?.month).toBe(earlier.toISOString().slice(0, 7));
    expect(host.textContent).toContain('No history');
  });
  it('hides shared billing for regular users and marks missing AI usage as unknown', async () => {
    isAdmin = false; unknown = 1; await render();
    expect(calls.some(call => call.path === '/api/billing/cloudflare')).toBe(false);
    expect(host.textContent).not.toContain('Cloudflare account charges');
    expect(host.textContent).toContain('Unknown');
    expect(host.textContent).toContain('Cost is incomplete');
  });
});
