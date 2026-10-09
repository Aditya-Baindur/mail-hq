// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageReader } from '../components/message-reader';
import { TooltipProvider } from '../components/ui/tooltip';
import type { Mail } from '../components/shared';

let root: Root;
let host: HTMLDivElement;
const message: Mail = {
  id: 'test', mailbox_id: 'box', sender: 'sender@example.com', sender_name: 'Sender',
  recipients: ['recipient@example.com'], cc: [], bcc: [], subject: 'Invoice details',
  snippet: 'Invoice preview', text: 'First invoice costs $100.00. Second INVOICE costs $100.00.',
  created_at: '2026-10-08T12:00:00Z', is_read: 1, starred: 0, folder: 'archive',
  direction: 'inbound', status: 'received',
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(query: string) {
  await act(async () => {
    root.render(createElement(TooltipProvider, null, createElement(MessageReader, {
      message, searchQuery: query, busy: false, position: '1 of 1',
      onBack() {}, onReply() {}, onForward() {}, onMutate() {}, onOpen() {},
    })));
  });
}
async function click(label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}
const count = () => host.querySelector('.mail-find-count')?.textContent;

describe('reader find controls', () => {
  it('keeps an ordinary email uncluttered and opens and closes find without losing the message', async () => {
    await render('');
    expect(host.querySelector('input[aria-label="Find text in this email"]')).toBeNull();
    await click('Find in this email');
    expect(host.querySelector('input[aria-label="Find text in this email"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Find in this email"]')?.getAttribute('aria-expanded')).toBe('true');
    await click('Close find');
    expect(host.querySelector('input[aria-label="Find text in this email"]')).toBeNull();
    expect(host.querySelector('.mail-plain-body')?.textContent).toBe(message.text);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Find in this email');
    await render('invoice');
    expect(host.querySelector('input[aria-label="Find text in this email"]')).not.toBeNull();
    expect(count()).toBe('1 of 2 in body');
  });
  it('carries the search into the reader and navigates, wraps and clears body matches', async () => {
    await render('invoice');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Find text in this email"]')?.value).toBe('invoice');
    expect(host.querySelectorAll('.mail-plain-body mark')).toHaveLength(2);
    expect(host.querySelector('.reader-subject mark')?.textContent).toBe('Invoice');
    expect(count()).toBe('1 of 2 in body');
    await click('Next match');
    expect(count()).toBe('2 of 2 in body');
    expect(host.querySelector('.mail-plain-body mark[data-active="true"]')?.textContent).toBe('INVOICE');
    await click('Next match');
    expect(count()).toBe('1 of 2 in body');
    await click('Previous match');
    expect(count()).toBe('2 of 2 in body');
    await click('Clear highlights');
    expect(host.querySelectorAll('mark')).toHaveLength(0);
    expect(host.querySelector('.mail-plain-body')?.textContent).toBe(message.text);
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')?.disabled).toBe(true);
  });
  it('supports editing the query, keyboard navigation and a no-match state', async () => {
    await render('invoice');
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Find text in this email"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, '$100.00');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(Array.from(host.querySelectorAll('.mail-plain-body mark'), (m) => m.textContent)).toEqual(['$100.00', '$100.00']);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(count()).toBe('2 of 2 in body');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); });
    expect(count()).toBe('1 of 2 in body');
    await act(async () => {
      setValue.call(input, 'missing');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(count()).toBe('No body matches');
    expect(host.querySelectorAll('mark')).toHaveLength(0);
  });
});
