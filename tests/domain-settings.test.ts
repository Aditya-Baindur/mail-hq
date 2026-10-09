// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../components/management';
import { TooltipProvider } from '../components/ui/tooltip';
import type { Bootstrap } from '../components/shared';
vi.mock('../components/mail-apps', () => ({ MailApps: () => null }));
let root: Root;
let host: HTMLDivElement;
const notify = vi.fn();
const initial: Bootstrap = {
  domains: [{ id: 'zone', name: 'example.com', receiving: 0, sending: 1, note: 'Old status' }],
  mailboxes: [],
  drafts: [],
  counts: [],
  identity: 'owner@example.com',
  provisioningConfigured: false,
  mcpUrl: 'https://mcp.example.com',
};
const result = {
  domains: [{ ...initial.domains[0], receiving: 1, note: 'Receiving DNS points to Cloudflare.' }],
  updated: 1,
  total: 1,
  source: 'dns',
  receivingChecked: 1,
  sendingChecked: 0,
  errors: [],
  warnings: [],
};
function Harness() {
  const [data, setData] = useState(initial);
  return createElement(
    TooltipProvider,
    null,
    createElement(Settings, {
      data,
      notify,
      refresh() {},
      onDomainsChange: (domains) => setData((current) => ({ ...current, domains })),
    }),
  );
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
  notify.mockClear();
});
const refreshButton = () =>
  Array.from(host.querySelectorAll('button')).find((button) =>
    /Refresh status|Refreshing/.test(button.textContent || ''),
  )!;
describe('domain refresh control', () => {
  it('works without the optional token, shows pending state, and applies returned status immediately', async () => {
    let finish!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect(refreshButton().disabled).toBe(false);
    await act(async () => refreshButton().click());
    expect(refreshButton().disabled).toBe(true);
    expect(refreshButton().textContent).toContain('Refreshing');
    expect(notify).not.toHaveBeenCalled();
    await act(async () => finish(Response.json(result)));
    expect(host.querySelector('.settings-domain')?.textContent).toContain('Ready');
    expect(host.querySelector('.settings-domain')?.textContent).not.toContain('Old status');
    expect(host.textContent).toContain('sending status was not checked');
    expect(refreshButton().disabled).toBe(false);
    expect(notify).toHaveBeenCalledWith('Receiving status refreshed');
  });
  it('shows refresh failures beside Domains and clears them on successful retry', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ error: 'DNS unavailable. Try again.' }, { status: 502 }),
      )
      .mockResolvedValueOnce(Response.json(result));
    await act(async () => refreshButton().click());
    const panel = refreshButton().closest('.panel')!;
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain('DNS unavailable');
    expect(notify).not.toHaveBeenCalled();
    await act(async () => refreshButton().click());
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    expect(notify).toHaveBeenCalledOnce();
  });
});

it('groups repeated permission warnings and avoids reporting a complete refresh', async () => {
  const message =
    'Cloudflare denied routing settings. Add Zone → Zone Settings → Read to the token for these domains. Receiving is checked using public DNS where possible.';
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      ...result,
      updated: 7,
      total: 7,
      source: 'mixed',
      receivingChecked: 7,
      sendingChecked: 7,
      warnings: Array.from({ length: 7 }, (_, i) => ({ domain: `domain${i}.example`, message })),
    }),
  );
  await act(async () => refreshButton().click());
  const panel = refreshButton().closest('.panel')!;
  expect(panel.querySelector('[role="alert"]')).toBeNull();
  expect(panel.textContent?.split(message)).toHaveLength(2);
  expect(panel.textContent).toContain('7 receiving checks completed; 7 sending checks completed');
  expect(notify).toHaveBeenCalledWith('7 domains checked');
  expect(notify).not.toHaveBeenCalledWith('Domain status refreshed');
});
