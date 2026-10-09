// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mailboxes } from '../components/management';
import { TooltipProvider } from '../components/ui/tooltip';
import type { Bootstrap } from '../components/shared';

const box = {
  id: 'box-one',
  address: 'research@example.com',
  name: 'Research',
  status: 'active',
  color: '#666666',
  unread: 2,
};
const initial: Bootstrap = {
  mailboxes: [box, { ...box, id: 'box-two', address: 'personal@example.com' }],
  domains: [],
  drafts: [],
  counts: [],
  identity: 'owner@example.com',
  provisioningConfigured: true,
  mcpUrl: '',
};
let root: Root;
let host: HTMLDivElement;
const onOpen = vi.fn();
const onDeleted = vi.fn();
function Harness() {
  const [data, setData] = useState(initial);
  return createElement(
    TooltipProvider,
    null,
    createElement(Mailboxes, {
      data,
      onCreate() {},
      onOpen,
      onDeleted(box) {
        onDeleted(box);
        setData((current) => ({
          ...current,
          mailboxes: current.mailboxes.filter((item) => item.id !== box.id),
        }));
      },
    }),
  );
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  onOpen.mockClear();
  onDeleted.mockClear();
});
const button = (text: string) =>
  Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === text,
  )!;
async function open() {
  const trigger = host.querySelector<HTMLButtonElement>(
    '[aria-label="Delete research@example.com"]',
  )!;
  await act(async () => {
    trigger.focus();
    trigger.click();
  });
  return trigger;
}
async function type(value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('#delete-mailbox-address')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => button('Delete address').click());
}

describe('delete address confirmation', () => {
  it('requires the address and lets Cancel close safely without opening the mailbox', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const trigger = await open();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'emails, drafts, and attachments',
    );
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'cannot be undone',
    );
    expect(button('Delete address').disabled).toBe(true);
    await type('personal@example.com');
    expect(button('Delete address').disabled).toBe(true);
    await act(async () => button('Cancel').click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(fetch).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows a pending state, prevents repeat submission, then removes only the chosen mailbox', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await open();
    await type('research@example.com');
    expect(button('Delete address').disabled).toBe(false);
    await submit();
    expect(button('Deleting…').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(true);
    await act(async () => button('Deleting…').click());
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      '/api/mailboxes/box-one',
      expect.objectContaining({ method: 'DELETE', body: '{"address":"research@example.com"}' }),
    );
    await act(async () => finish(Response.json({ ok: true })));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(onDeleted).toHaveBeenCalledWith(box);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(host.querySelector('[aria-label="Open research@example.com"]')).toBeNull();
    expect(host.querySelector('[aria-label="Open personal@example.com"]')).not.toBeNull();
    expect(document.activeElement).toBe(button('Create mailbox'));
  });

  it('keeps an error in the dialog and allows a successful retry', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json(
          { error: 'Cloudflare denied routing access. Update the token and retry.' },
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await open();
    await type('research@example.com');
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Update the token and retry',
    );
    expect(onDeleted).not.toHaveBeenCalled();
    expect(button('Delete address').disabled).toBe(false);
    expect(host.querySelectorAll('.mailbox-entry')).toHaveLength(2);
    await submit();
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(host.querySelectorAll('.mailbox-entry')).toHaveLength(1);
  });
});
