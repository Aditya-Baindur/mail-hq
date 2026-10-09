import { afterEach, describe, expect, it, vi } from 'vitest';
import { receivingDns, syncDomains } from '../worker/src/domains';
import { fetchApi } from '../worker/src/index';
import { setup } from './helpers';

const fixtures: ReturnType<typeof setup>[] = [];
const fixture = () => {
  const f = setup();
  fixtures.push(f);
  return f;
};
const dns = (hosts: string[], status = 0) =>
  Response.json({
    Status: status,
    Answer: hosts.map((host) => ({ type: 15, data: `10 ${host}` })),
  });
const cf = (result: unknown) => Response.json({ success: true, result });
afterEach(() => {
  vi.restoreAllMocks();
  fixtures.splice(0).forEach((f) => f.close());
});

describe('domain status refresh', () => {
  it('refreshes receiving without a provisioning token and preserves sending and routing safeguards', async () => {
    const f = fixture();
    f.sql.exec("UPDATE domains SET receiving=0,routing_mode='managed' WHERE name='example.com'");
    const requests = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://cloudflare-dns.com');
      expect(url.searchParams.get('type')).toBe('MX');
      return dns(
        url.searchParams.get('name') === 'example.com'
          ? ['ROUTE1.MX.CLOUDFLARE.NET.', 'route2.mx.cloudflare.net']
          : ['mx.external.example.'],
      );
    });
    const response = await fetchApi(
      new Request('http://localhost/api/domains/sync', {
        method: 'POST',
        headers: { Origin: 'http://localhost' },
      }),
      f.env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(response?.status).toBe(200);
    const result = (await response!.json()) as Awaited<ReturnType<typeof syncDomains>>;
    expect(result).toMatchObject({ source: 'dns', updated: 2, total: 2, errors: [] });
    expect(result.domains.find((d) => d.name === 'example.com')).toMatchObject({
      receiving: 1,
      sending: 1,
      routing_mode: 'managed',
    });
    expect(result.domains.find((d) => d.name === 'external.example')).toMatchObject({
      receiving: 0,
      sending: 0,
    });
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM protected_addresses').get()?.n).toBe(2);
    expect(requests).toHaveBeenCalledTimes(2);
  });
  it('keeps the previous state on DNS failure and still refreshes the other domains', async () => {
    const f = fixture();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      new URL(String(input)).searchParams.get('name') === 'example.com'
        ? dns([], 2)
        : dns(['route1.mx.cloudflare.net']),
    );
    const result = await syncDomains(f.env);
    expect(result).toMatchObject({ updated: 1, total: 2 });
    expect(result.errors[0].domain).toBe('example.com');
    expect(result.domains.find((d) => d.name === 'example.com')).toMatchObject({
      receiving: 1,
      sending: 1,
    });
    expect(result.domains.find((d) => d.name === 'external.example')).toMatchObject({
      receiving: 1,
      sending: 0,
    });
  });
  it('does not interpret HTTP or truncated DNS errors as disabled receiving', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ Status: 0, TC: true }));
    await expect(receivingDns('example.com')).rejects.toThrow('DNS lookup failed');
    await expect(receivingDns('example.com')).rejects.toThrow('previous status');
  });
  it('distinguishes no MX, mixed providers, and lookalike hostnames from Cloudflare receiving', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const hosts of [
      [],
      ['.'],
      ['route1.mx.cloudflare.net', 'mx.external.example'],
      ['route1.mx.cloudflare.net.attacker.example'],
    ]) {
      fetch.mockResolvedValueOnce(dns(hosts));
      expect((await receivingDns('example.com')).receiving).toBe(false);
    }
  });
  it('uses authenticated Cloudflare status when configured without changing managed routing', async () => {
    const f = fixture();
    f.env.CF_API_TOKEN = 'test-only';
    f.sql.exec("UPDATE domains SET routing_mode='managed' WHERE name='example.com'");
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(init?.method || 'GET').toBe('GET');
      if (url.pathname.endsWith('/zones'))
        return cf([
          {
            id: '11111111111111111111111111111111',
            name: 'example.com',
            account: { id: f.env.ACCOUNT_ID },
          },
          { id: 'foreign', name: 'foreign.example', account: { id: 'other' } },
        ]);
      if (url.pathname.endsWith('/email/routing')) return cf({ enabled: true });
      if (url.pathname.endsWith('/dns_records'))
        return cf([{ content: 'ROUTE1.MX.CLOUDFLARE.NET.' }]);
      if (url.pathname.endsWith('/subdomains'))
        return cf([{ name: 'EXAMPLE.COM.', enabled: false }]);
      throw new Error('Unexpected request');
    });
    const result = await syncDomains(f.env);
    expect(result).toMatchObject({
      source: 'cloudflare',
      updated: 2,
      total: 2,
      errors: [],
      warnings: [],
    });
    expect(result.domains.find((d) => d.name === 'example.com')).toMatchObject({
      receiving: 1,
      sending: 0,
      routing_mode: 'managed',
    });
    expect(result.domains.some((d) => d.name === 'foreign.example')).toBe(false);
  });
  it('does not let missing sending permissions break receiving refresh or erase the last sending state', async () => {
    const f = fixture();
    f.env.CF_API_TOKEN = 'test-only';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/zones'))
        return cf([
          {
            id: '11111111111111111111111111111111',
            name: 'example.com',
            account: { id: f.env.ACCOUNT_ID },
          },
        ]);
      if (url.pathname.endsWith('/email/routing')) return cf({ enabled: true });
      if (url.pathname.endsWith('/dns_records'))
        return cf([{ content: 'route1.mx.cloudflare.net' }]);
      return Response.json(
        { success: false, errors: [{ message: 'Permission denied' }] },
        { status: 403 },
      );
    });
    const result = await syncDomains(f.env);
    expect(result.updated).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.warnings[0].message).toContain('Sending was not checked');
    expect(result.domains.find((d) => d.name === 'example.com')?.sending).toBe(1);
  });
});

describe('connected tokens with incomplete permissions', () => {
  const restricted = () =>
    Response.json(
      { success: false, errors: [{ message: 'Authentication error' }] },
      { status: 403 },
    );
  it('reproduces seven routing authentication failures and refreshes all seven using DNS', async () => {
    const f = fixture();
    f.env.CF_API_TOKEN = 'test-only';
    const zones = Array.from({ length: 7 }, (_, i) => ({
      id: String(i + 1).repeat(32),
      name: i === 0 ? 'example.com' : i === 1 ? 'external.example' : `domain${i}.example`,
      account: { id: f.env.ACCOUNT_ID },
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'cloudflare-dns.com')
        return dns(
          url.searchParams.get('name') === 'external.example'
            ? ['mx.external.example']
            : ['route1.mx.cloudflare.net'],
        );
      if (url.pathname.endsWith('/zones')) return cf(zones);
      if (url.pathname.endsWith('/email/routing')) return restricted();
      if (url.pathname.endsWith('/dns_records'))
        return cf([{ content: 'route1.mx.cloudflare.net' }]);
      if (url.pathname.endsWith('/subdomains')) {
        const zone = zones.find((zone) => url.pathname.includes(zone.id))!;
        return cf([{ name: zone.name, enabled: true }]);
      }
      throw new Error('Unexpected URL');
    });
    const result = await syncDomains(f.env);
    expect(result).toMatchObject({
      updated: 7,
      total: 7,
      receivingChecked: 7,
      sendingChecked: 7,
      source: 'mixed',
      errors: [],
    });
    expect(result.warnings).toHaveLength(7);
    expect(new Set(result.warnings.map((warning) => warning.message)).size).toBe(1);
    expect(result.warnings[0].message).toContain('Zone → Zone Settings → Read');
    expect(result.domains).toHaveLength(7);
    expect(result.domains.every((domain) => domain.sending === 1)).toBe(true);
    expect(result.domains.find((domain) => domain.name === 'external.example')?.receiving).toBe(0);
  });
  it('keeps working when all token calls are denied, and does not erase sending state', async () => {
    const f = fixture();
    f.env.CF_API_TOKEN = 'test-only';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      new URL(String(input)).hostname === 'cloudflare-dns.com'
        ? dns(['route1.mx.cloudflare.net'])
        : restricted(),
    );
    const result = await syncDomains(f.env);
    expect(result).toMatchObject({
      updated: 2,
      receivingChecked: 2,
      sendingChecked: 0,
      source: 'mixed',
      errors: [],
    });
    expect(result.domains.find((domain) => domain.name === 'example.com')?.sending).toBe(1);
    expect(result.warnings.some((warning) => warning.message.includes('domain discovery'))).toBe(
      true,
    );
    expect(result.warnings.some((warning) => warning.message.includes('Zone → DNS → Read'))).toBe(
      true,
    );
  });
  it('honors confirmed disabled routing even when DNS lookup falls back successfully', async () => {
    const f = fixture();
    f.env.CF_API_TOKEN = 'test-only';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'cloudflare-dns.com') return dns(['route1.mx.cloudflare.net']);
      if (url.pathname.endsWith('/zones')) return cf([]);
      if (url.pathname.endsWith('/email/routing')) return cf({ enabled: false });
      if (url.pathname.endsWith('/dns_records')) return restricted();
      return cf([]);
    });
    const result = await syncDomains(f.env);
    expect(result.domains.every((domain) => domain.receiving === 0)).toBe(true);
    expect(result.receivingChecked).toBe(2);
  });
  it('persists a successful sending check when both routing and public DNS fail', async () => {
    const f = fixture();
    f.env.CF_API_TOKEN = 'test-only';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'cloudflare-dns.com') return dns([], 2);
      if (url.pathname.endsWith('/zones')) return cf([]);
      if (url.pathname.endsWith('/subdomains'))
        return cf([{ name: 'external.example', enabled: true }]);
      return restricted();
    });
    const result = await syncDomains(f.env);
    expect(result).toMatchObject({ updated: 2, receivingChecked: 0, sendingChecked: 2 });
    expect(result.domains.find((domain) => domain.name === 'example.com')).toMatchObject({
      receiving: 1,
      sending: 0,
    });
    expect(result.domains.find((domain) => domain.name === 'external.example')).toMatchObject({
      receiving: 0,
      sending: 1,
    });
    expect(result.errors).toHaveLength(2);
  });
});
