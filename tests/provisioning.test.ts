import { afterEach, describe, expect, it, vi } from 'vitest';
import { provision } from '../worker/src/cloudflare';
import { fetchApi } from '../worker/src/index';
import { setup } from './helpers';

const fixtures: ReturnType<typeof setup>[] = [];
const fixture = () => {
  const f = setup();
  f.env.CF_API_TOKEN = 'test-only';
  fixtures.push(f);
  return f;
};
const input = {
  localPart: 'hi',
  domainId: '11111111111111111111111111111111',
  name: 'hi',
  color: '#666666',
};
const cf = (result: unknown) => Response.json({ success: true, result });
const denied = () =>
  Response.json(
    { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
    { status: 403 },
  );
const dns = (hosts = ['ROUTE1.MX.CLOUDFLARE.NET.']) =>
  Response.json({
    Status: 0,
    Answer: hosts.map((host) => ({ type: 15, data: `10 ${host}` })),
  });
const rule = {
  id: 'new-route',
  matchers: [{ type: 'literal', field: 'to', value: 'hi@example.com' }],
};

function mockProvider(
  options: {
    settings?: () => Response;
    records?: () => Response;
    dns?: () => Response;
    rules?: (url: URL) => Response;
    create?: () => Response;
  } = {},
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
    const url = new URL(String(request));
    if (url.origin === 'https://cloudflare-dns.com') {
      expect(url.searchParams.get('name')).toBe('example.com');
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return options.dns?.() ?? dns();
    }
    expect(url.origin).toBe('https://api.cloudflare.com');
    if (url.pathname.endsWith('/email/routing')) return options.settings?.() ?? denied();
    if (url.pathname.endsWith('/dns_records'))
      return options.records?.() ?? cf([{ content: 'route1.mx.cloudflare.net' }]);
    if (url.pathname.endsWith('/email/routing/rules')) {
      if (init?.method === 'POST') return options.create?.() ?? cf(rule);
      expect(url.searchParams.get('per_page')).toBe('50');
      return options.rules?.(url) ?? cf([]);
    }
    throw new Error(`Unexpected provider request: ${url.pathname}`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  fixtures.splice(0).forEach((f) => f.close());
});

describe('mailbox provisioning with restricted status permissions', () => {
  it('creates through the dashboard API without Zone Settings Read after verifying DNS and rules', async () => {
    const f = fixture();
    const requests = mockProvider();
    const response = await fetchApi(
      new Request('http://localhost/api/mailboxes', {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
      f.env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(response?.status).toBe(201);
    const created = (await response!.json()) as { id: string; address: string };
    expect(created.address).toBe('hi@example.com');
    expect(
      f.sql.prepare('SELECT status,routing_rule_id FROM mailboxes WHERE id=?').get(created.id),
    ).toMatchObject({ status: 'active', routing_rule_id: 'new-route' });
    const writes = requests.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({
      name: 'Mail HQ: hi@example.com',
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: 'hi@example.com' }],
      actions: [{ type: 'worker', value: ['mail-hq'] }],
      priority: 0,
    });
    expect(requests.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/client/v4/zones/${input.domainId}/email/routing`,
      '/dns-query',
      `/client/v4/zones/${input.domainId}/email/routing/rules`,
      `/client/v4/zones/${input.domainId}/email/routing/rules`,
    ]);
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM protected_addresses').get()?.n).toBe(2);
    expect(
      f.sql.prepare('SELECT action FROM audit_events WHERE mailbox_id=?').get(created.id)?.action,
    ).toBe('mailbox.created');
  });

  it('verifies public DNS when DNS Read is missing', async () => {
    const f = fixture();
    const requests = mockProvider({ settings: () => cf({ enabled: true }), records: denied });
    await expect(provision(f.env, 'owner', input)).resolves.toMatchObject({
      address: 'hi@example.com',
    });
    expect(requests.mock.calls.some(([url]) => String(url).includes('cloudflare-dns.com'))).toBe(
      true,
    );
  });

  it('accepts case-insensitive Cloudflare MX records with a trailing dot', async () => {
    const f = fixture();
    const requests = mockProvider({
      settings: () => cf({ enabled: true }),
      records: () => cf([{ content: 'ROUTE1.MX.CLOUDFLARE.NET.' }]),
    });
    await expect(provision(f.env, 'owner', input)).resolves.toMatchObject({
      address: 'hi@example.com',
    });
    expect(requests.mock.calls.some(([url]) => String(url).includes('cloudflare-dns.com'))).toBe(
      false,
    );
  });

  it.each([
    { hosts: [] },
    { hosts: ['mx.external.example'] },
    { hosts: ['route1.mx.cloudflare.net', 'mx.external.example'] },
    { hosts: ['route1.mx.cloudflare.net.attacker.example'] },
  ])('refuses non-Cloudflare mail receiving: $hosts', async ({ hosts }) => {
    const f = fixture();
    const requests = mockProvider({ dns: () => dns(hosts) });
    await expect(provision(f.env, 'owner', input)).rejects.toThrow('existing routing is protected');
    expect(requests.mock.calls.some(([url]) => String(url).includes('/rules'))).toBe(false);
    expect(
      f.sql.prepare('SELECT id FROM mailboxes WHERE address=?').get('hi@example.com'),
    ).toBeUndefined();
  });

  it('stops on unverified DNS instead of trusting saved receiving status', async () => {
    const f = fixture();
    const requests = mockProvider({ dns: () => Response.json({ Status: 2 }) });
    await expect(provision(f.env, 'owner', input)).rejects.toMatchObject({ status: 503 });
    expect(requests.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('does not override an explicitly disabled routing setting', async () => {
    const f = fixture();
    const requests = mockProvider({ settings: () => cf({ enabled: false }) });
    await expect(provision(f.env, 'owner', input)).rejects.toThrow('not enabled');
    expect(requests).toHaveBeenCalledTimes(1);
  });

  it('does not treat an upstream outage as missing read permission', async () => {
    const f = fixture();
    const requests = mockProvider({
      settings: () =>
        Response.json(
          { success: false, errors: [{ message: 'Service unavailable' }] },
          { status: 503 },
        ),
    });
    await expect(provision(f.env, 'owner', input)).rejects.toThrow('Service unavailable');
    expect(requests).toHaveBeenCalledTimes(1);
  });

  it('protects existing addresses on later pages of routing rules', async () => {
    const f = fixture();
    const requests = mockProvider({
      rules: (url) =>
        cf(
          url.searchParams.get('page') === '1'
            ? Array.from({ length: 50 }, (_, index) => ({
                id: String(index),
                matchers: [{ value: `old${index}@example.com` }],
              }))
            : [{ ...rule, matchers: [{ value: 'HI@EXAMPLE.COM' }] }],
        ),
    });
    await expect(provision(f.env, 'owner', input)).rejects.toThrow('already has a routing rule');
    expect(requests.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(requests.mock.calls.some(([url]) => String(url).includes('page=2'))).toBe(true);
  });

  it('requires readable routing rules even when public MX is valid', async () => {
    const f = fixture();
    const requests = mockProvider({ rules: denied });
    await expect(provision(f.env, 'owner', input)).rejects.toThrow(
      'Zone → Email Routing Rules → Edit',
    );
    expect(requests.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(
      f.sql.prepare('SELECT id FROM mailboxes WHERE address=?').get('hi@example.com'),
    ).toBeUndefined();
  });

  it('returns an actionable permission error and permits retry after a rejected rule creation', async () => {
    const f = fixture();
    let writable = false;
    const requests = mockProvider({ create: () => (writable ? cf(rule) : denied()) });
    await expect(provision(f.env, 'owner', input)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('access to this domain, then try again'),
    });
    expect(
      f.sql.prepare('SELECT id FROM mailboxes WHERE address=?').get('hi@example.com'),
    ).toBeUndefined();
    writable = true;
    await expect(provision(f.env, 'owner', input)).resolves.toMatchObject({
      address: 'hi@example.com',
    });
    expect(requests.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM mailboxes').get()?.n).toBe(3);
  });

  it('keeps the reservation after an uncertain write failure to prevent duplicate routing rules', async () => {
    const f = fixture();
    mockProvider({
      create: () => {
        throw new Error('Connection closed');
      },
    });
    await expect(provision(f.env, 'owner', input)).rejects.toThrow('Connection closed');
    expect(
      f.sql.prepare('SELECT status,error FROM mailboxes WHERE address=?').get('hi@example.com'),
    ).toMatchObject({ status: 'failed', error: 'Connection closed' });
  });
});
