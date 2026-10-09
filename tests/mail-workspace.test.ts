// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dashboard from '../components/dashboard';
import type { Bootstrap, Mail } from '../components/shared';

let root: Root;
let host: HTMLDivElement;
let width = 1440;
const messages: Mail[] = ['First email', 'Second email'].map((subject, i) => ({
  id: `message-${i}`, mailbox_id: 'box', mailbox_address: 'me@example.com',
  sender: 'sender@example.com', sender_name: 'Sender', recipients: ['me@example.com'], cc: [], bcc: [],
  subject, snippet: `Preview ${i}`, text: `Email body ${i}`, created_at: '2026-10-08T12:00:00Z',
  is_read: 1, starred: 0, folder: 'inbox', direction: 'inbound', status: 'received',
}));
const bootstrap: Bootstrap = {
  mailboxes: [{ id: 'box', address: 'me@example.com', name: 'Personal', color: '#007aff', status: 'active', unread: 0 }],
  domains: [], drafts: [], counts: [{ mailbox_id: 'box', folder: 'inbox', count: 2, unread: 0 }],
  identity: 'me@example.com', provisioningConfigured: true, mcpUrl: 'https://mcp.example.com/mcp',
};
beforeEach(() => {
  width = 1440;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query.includes('max-width') ? width <= Number(query.match(/\d+/)?.[0]) : width >= Number(query.match(/\d+/)?.[0]),
    media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return true; },
  })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (path: string | URL | Request) => {
    const url = new URL(String(path), 'http://localhost');
    if (url.pathname === '/api/bootstrap') return Response.json(bootstrap);
    if (url.pathname === '/api/messages') {
      const q = url.searchParams.get('q')?.toLowerCase() || '';
      const result = messages.filter((m) => m.subject.toLowerCase().includes(q));
      return Response.json({ messages: result, total: result.length, nextCursor: null });
    }
    if (url.pathname.endsWith('/thread')) return Response.json({ messages: [] });
    const message = messages.find((m) => url.pathname === `/api/messages/${m.id}`);
    if (message) return Response.json(message);
    throw new Error(`Unexpected test request: ${url.pathname}`);
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});
async function render(viewport = 1440) {
  width = viewport;
  vi.stubGlobal('innerWidth', viewport);
  await act(async () => { root.render(createElement(Dashboard)); });
  expect(host.querySelectorAll('.inbox-row')).toHaveLength(2);
}
async function open(id: string) {
  await act(async () => { host.querySelector<HTMLButtonElement>(`[data-message-id="${id}"]`)!.click(); });
}

describe('mail split workspace', () => {
  it('keeps the list and its scroll position while switching the reading pane', async () => {
    await render();
    const list = host.querySelector<HTMLElement>('.inbox-list')!;
    const surface = host.querySelector<HTMLElement>('.inbox-surface')!;
    list.scrollTop = 120;
    expect(host.querySelector('.mail-reader-empty')?.textContent).toContain('No message selected');
    await open('message-0');
    expect(surface.hidden).toBe(false);
    expect(host.querySelector('.inbox-list')).toBe(list);
    expect(list.scrollTop).toBe(120);
    expect(host.querySelectorAll('.mail-row-open')).toHaveLength(2);
    expect(host.querySelector('.mail-plain-body')?.textContent).toBe('Email body 0');
    expect(host.querySelector('[data-message-id="message-0"]')?.getAttribute('aria-current')).toBe('true');
    await open('message-1');
    expect(surface.hidden).toBe(false);
    expect(host.querySelector('.mail-plain-body')?.textContent).toBe('Email body 1');
    expect(host.querySelectorAll('.inbox-row.is-selected')).toHaveLength(1);
    expect(host.querySelector('[data-message-id="message-0"]')?.hasAttribute('aria-current')).toBe(false);
    expect(list.scrollTop).toBe(120);
  });
  it('updates the selected list row when navigating from the reader toolbar', async () => {
    await render();
    await open('message-0');
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Next message · J"]')!.click(); });
    expect(host.querySelector('.inbox-row.is-selected [data-message-id]')?.getAttribute('data-message-id')).toBe('message-1');
    expect(host.querySelector('.mail-plain-body')?.textContent).toBe('Email body 1');
    expect(host.querySelector<HTMLElement>('.inbox-surface')?.hidden).toBe(false);
  });
  it('shows one pane on phones and returns to the same list with Back', async () => {
    await render(390);
    const list = host.querySelector<HTMLElement>('.inbox-list')!;
    list.scrollTop = 90;
    expect(host.querySelector<HTMLElement>('.mail-reader-surface')?.hidden).toBe(true);
    await open('message-0');
    expect(host.querySelector<HTMLElement>('.inbox-surface')?.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>('.mail-reader-surface')?.hidden).toBe(false);
    await act(async () => { host.querySelector<HTMLButtonElement>('.reader-back')!.click(); });
    expect(host.querySelector<HTMLElement>('.inbox-surface')?.hidden).toBe(false);
    expect(host.querySelector<HTMLElement>('.mail-reader-surface')?.hidden).toBe(true);
    expect(host.querySelector('.inbox-list')).toBe(list);
    expect(list.scrollTop).toBe(90);
  });
  it('keeps search available beside an open message and opens highlighted results', async () => {
    await render();
    await open('message-0');
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search mail"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Second');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(host.querySelectorAll('.inbox-row')).toHaveLength(1);
    expect(host.querySelector('.mail-reader-empty')).not.toBeNull();
    await open('message-1');
    expect(host.querySelector('.reader-subject mark')?.textContent).toBe('Second');
    expect(host.querySelector<HTMLElement>('.inbox-surface')?.hidden).toBe(false);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('folder=all&q=Second'))).toBe(true);
  });
});
