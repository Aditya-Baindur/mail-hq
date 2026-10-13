// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agents } from '../components/management';
import { TooltipProvider } from '../components/ui/tooltip';

const box = { id: 'box', address: 'work@example.com', name: 'Work', status: 'active', color: '#666', unread: 0 };
const base = { address: box.address, scopes: ['read'], prefix: 'mhq_example', created_at: '2026-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', revoked_at: null as string | null, last_used_at: null };
let manual: (typeof base & { id: string; name: string })[];
let oauth: typeof manual;
let root: Root;
let host: HTMLDivElement;
const notify = vi.fn();
const writeText = vi.fn();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  manual = [
    { ...base, id: 'shared-id', name: 'Research script' },
    { ...base, id: 'expired', name: 'Old script', expires_at: '2000-01-01T00:00:00Z' },
  ];
  oauth = [
    { ...base, id: 'shared-id', name: 'Cursor' },
    { ...base, id: 'revoked', name: 'Old client', revoked_at: '2026-01-02T00:00:00Z' },
    { ...base, id: 'inactive-mailbox', name: 'Paused mailbox client', address: 'paused@example.com' },
  ];
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/api/tokens' && options?.method === 'POST') return Response.json({ token: 'mhq_example-secret' }, { status: 201 });
    if (options?.method === 'DELETE') {
      const collection = path.includes('/oauth/') ? oauth : manual;
      const token = collection.find(item => path.endsWith(`/${item.id}`))!;
      token.revoked_at = new Date().toISOString();
      return Response.json({ ok: true });
    }
    if (path === '/api/tokens') return Response.json({ tokens: manual });
    if (path === '/api/oauth/connections') return Response.json({ connections: oauth });
    throw new Error(`Unexpected request: ${path}`);
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  notify.mockClear();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(createElement(TooltipProvider, null, createElement(Agents, {
    mailboxes: [box, { ...box, id: 'paused', address: 'paused@example.com', status: 'paused' }],
    mcpUrl: 'https://mcp.example.com/mcp', notify,
  }))));
}
async function selectSpace(label: string) {
  await act(async () => Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]'))
    .find(tab => tab.textContent?.startsWith(label))!.focus());
}
function rows() { return Array.from(host.querySelectorAll('.agent-row')).map(row => row.textContent); }
function button(label: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === label)!;
}
async function createManualToken(name: string) {
  await render();
  await act(async () => button('Connect agent').click());
  await act(async () => button('Create manual token').click());
  expect(button('Create connection').disabled).toBe(true);
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('#agent-name')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Create connection').click());
}

describe('manual token setup', () => {
  it('uses the entered name and copies a Cursor config separately from the environment key', async () => {
    await createManualToken('  My App  ');
    const request = vi.mocked(fetch).mock.calls.find(([path, options]) => path === '/api/tokens' && options?.method === 'POST')!;
    expect(JSON.parse(request[1]!.body as string)).toEqual({ name: 'My App', mailboxId: 'box', scopes: ['read'], expiresInDays: 90 });
    expect(document.querySelector('.token-connection-summary')?.textContent).toContain('My App');
    const config = document.querySelector('pre[aria-label="MCP configuration"]')!.textContent!;
    expect(JSON.parse(config)).toEqual({ mcpServers: {
      'My App': { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${env:MY_APP_MAIL_KEY}' } },
    } });
    expect(config).not.toContain('mhq_example-secret');
    await act(async () => button('Copy config').click());
    expect(writeText).toHaveBeenLastCalledWith(config);
    expect(button('Copied config')).toBeDefined();
    expect(button('Copy key')).toBeDefined();
    await act(async () => button('Copy key').click());
    expect(writeText).toHaveBeenLastCalledWith('MY_APP_MAIL_KEY=mhq_example-secret');
    expect(button('Copied key')).toBeDefined();
    expect(button('Copy config')).toBeDefined();
    expect(document.querySelector('pre[aria-label="Environment key"]')!.textContent).toBe('MY_APP_MAIL_KEY=mhq_example-secret');
    await act(async () => button('Done').click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain('mhq_example-secret');
  });

  it('keeps the key available if copying fails and clears the error on retry', async () => {
    await createManualToken('Research assistant');
    writeText.mockRejectedValueOnce(new Error('Clipboard permission denied'));
    await act(async () => button('Copy key').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not copy the key');
    expect(document.querySelector('pre[aria-label="Environment key"]')?.textContent).toContain('RESEARCH_ASSISTANT_MAIL_KEY=mhq_example-secret');
    await act(async () => button('Copy key').click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(writeText).toHaveBeenLastCalledWith('RESEARCH_ASSISTANT_MAIL_KEY=mhq_example-secret');
  });
});

describe('agent connection spaces', () => {
  it('keeps keyboard focus in manual setup and returns it to Connect agent on cancel', async () => {
    await render();
    const connect = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Connect agent')!;
    await act(async () => { connect.focus(); connect.click(); });
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'Create manual token')!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(document.activeElement?.id).toBe('agent-name');
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find(button => button.textContent === 'Cancel')!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(document.activeElement).toBe(connect);
    expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('separates usable access from expired, revoked, and inactive-mailbox connections', async () => {
    await render();
    expect(rows()).toHaveLength(2);
    expect(rows().join(' ')).toContain('Cursor');
    expect(rows().join(' ')).toContain('Research script');
    expect(rows().join(' ')).not.toContain('Old');
    await selectSpace('Inactive');
    expect(rows()).toHaveLength(3);
    expect(rows().join(' ')).toContain('Expired');
    expect(rows().join(' ')).toContain('Revoked');
    expect(rows().join(' ')).toContain('Mailbox inactive');
    expect(host.querySelector('[aria-label="Revoke Old script access to work@example.com"]')).toBeNull();
  });

  it('filters by mailbox or name and provides a way to clear an empty search', async () => {
    await render();
    const input = host.querySelector<HTMLInputElement>('[aria-label="Search connections"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'missing@example.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain('No matching connections');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Clear connection search"]')!.click());
    expect(rows()).toHaveLength(2);
  });

  it('moves only the revoked connection into Inactive after confirmation', async () => {
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Revoke Cursor access to work@example.com"]')!.click());
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('work@example.com');
    expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'))
      .find(button => button.textContent === 'Revoke access')!.click());
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Research script');
    expect(notify).toHaveBeenCalledWith('Access revoked. Connection moved to Inactive.');
    await selectSpace('Inactive');
    expect(rows()).toHaveLength(4);
    expect(rows().join(' ')).toContain('Cursor');
  });

  it('offers a retry instead of presenting a failed fetch as an empty account', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection unavailable'));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Connection unavailable');
    expect(host.textContent).not.toContain('No active connections');
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'Try again')!.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(rows()).toHaveLength(2);
  });
});
