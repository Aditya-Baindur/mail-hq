// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AiWorkspace from '../components/ai-workspace';

let root: Root, host: HTMLDivElement;
let saved: Record<string, unknown>[];
let calls: { url: string; method: string; body: Record<string, unknown> }[];
let checked: number;
let runError: boolean;
let holdRun: (() => void) | undefined;
let pause: boolean;
const result = () => ({ filter: { id: 'filter', name: 'Interview requests', version: 1 },
  stats: { total: 6, checked, matched: checked ? 1 : 0, pending: 6 - checked, truncated: 0 }, nextOffset: null,
  messages: checked ? [{ id: 'message', subject: 'Meet our hiring manager', sender: 'recruiter@example.com', snippet: 'Are you available Thursday?', probability: 0.99, is_read: 0, created_at: '2026-10-12' }] : [] });
beforeEach(() => {
  saved = []; calls = []; checked = 0; runError = false; pause = false; holdRun = undefined;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost'), method = init?.method || 'GET', body = JSON.parse(String(init?.body || '{}'));
    calls.push({ url: url.pathname, method, body });
    if (url.pathname === '/api/bootstrap') return Response.json({ mailboxes: [{ id: 'box', address: 'work@example.com', name: 'Work', status: 'active' }] });
    if (url.pathname === '/api/ai/filters' && method === 'GET') return Response.json({ filters: saved });
    if (url.pathname === '/api/ai/filters' && method === 'POST') {
      const filter = { ...body, id: 'filter', version: 1, mailbox_id: body.mailboxId }; saved = [filter]; return Response.json({ filter });
    }
    if (url.pathname.endsWith('/run')) {
      if (pause) await new Promise<void>(resolve => { holdRun = resolve; });
      if (runError) return Response.json({ error: 'Cloudflare Clef could not evaluate this batch. Retry to resume.' }, { status: 502 });
      checked = Math.min(6, checked + 4); return Response.json({ stats: result().stats });
    }
    if (url.pathname.endsWith('/results')) return Response.json(result());
    if (url.pathname === '/api/ai/filters/filter' && method === 'DELETE') { saved = []; return Response.json({ ok: true }); }
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(createElement(AiWorkspace))); }
const button = (text: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === text)!;
async function click(text: string) { await act(async () => button(text).click()); }
async function example() { await render(); await click('Interview requests'); }

describe('AI workspace', () => {
  it('saves a natural-language example and scans all batches without changing the normal mailbox', async () => {
    await example();
    expect(host.querySelector<HTMLAnchorElement>('a.ai-back')?.getAttribute('href')).toBe('/');
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(calls.find(c => c.method === 'POST' && c.url === '/api/ai/filters')?.body.instructions).toContain('Exclude job listings');
    expect(calls.filter(c => c.url.endsWith('/run'))).toHaveLength(2);
    expect(host.textContent).toContain('6 of 6 emails checked');
    expect(host.textContent).toContain('Scan complete');
    expect(host.querySelector('.ai-message')?.textContent).toContain('Meet our hiring manager');
    expect(calls.some(c => c.url.startsWith('/api/messages') && c.method !== 'GET')).toBe(false);
  });
  it('saves without running AI, then lets users delete a filter while keeping emails', async () => {
    await example(); await click('Save');
    expect(calls.some(c => c.url.endsWith('/run'))).toBe(false);
    await click('Delete');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('All emails stay');
    await click('Delete filter');
    expect(saved).toEqual([]);
    expect(calls.some(c => c.method === 'DELETE' && c.url === '/api/ai/filters/filter')).toBe(true);
  });
  it('shows provider errors without claiming the scan completed', async () => {
    await example(); runError = true;
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Retry to resume');
    expect(host.textContent).not.toContain('Scan complete');
    expect(button('Save & run').disabled).toBe(false);
  });
  it('stops after the in-flight batch and resumes unchecked mail on the next run', async () => {
    await example(); pause = true;
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(holdRun).toBeDefined();
    await click('Stop scan');
    await act(async () => { pause = false; holdRun!(); });
    expect(calls.filter(c => c.url.endsWith('/run'))).toHaveLength(1);
    expect(host.textContent).toContain('4 of 6 emails checked · 2 remaining');
    expect(host.textContent).toContain('Scan stopped');
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(calls.filter(c => c.url.endsWith('/run'))).toHaveLength(2);
    expect(host.textContent).toContain('Scan complete');
  });
});
