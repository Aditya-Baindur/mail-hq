import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredEnv, saveToken } from '../worker/src/settings';
import { fetchApi } from '../worker/src/index';
import { setup } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('portable deployment', () => {
  it('creates an empty schema without seeding another account’s domains or addresses', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(readFileSync('migrations/0001_mail.sql', 'utf8'));
      db.exec(readFileSync('migrations/0002_managed_routing.sql', 'utf8'));
      for (const table of ['domains', 'mailboxes', 'messages', 'protected_addresses']) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it('validates a provisioning token against a zone in the configured account', async () => {
    const f = setup();
    try {
      f.env.CONFIG_ENCRYPTION_KEY = btoa('x'.repeat(32));
      const zoneId = '44444444444444444444444444444444';
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).endsWith('/zones?per_page=50')) {
          return Response.json({
            success: true,
            result: [
              { id: 'another-zone', account: { id: 'another-account' } },
              { id: zoneId, account: { id: f.env.ACCOUNT_ID } },
            ],
          });
        }
        expect(String(url)).toContain(`/zones/${zoneId}/`);
        return Response.json({ success: true, result: [] });
      });
      expect(await saveToken(f.env, 'test-only-provisioning-credential')).toEqual({ warnings: [] });
      expect(fetch).toHaveBeenCalledTimes(5);
      expect((await configuredEnv(f.env)).CF_API_TOKEN).toBe('test-only-provisioning-credential');
      expect(new TextDecoder().decode(f.objects.get('system/provisioning-token'))).not.toContain(
        'test-only-provisioning-credential',
      );
    } finally {
      f.close();
    }
  });

  it('rejects a provisioning token from another account before storing it', async () => {
    const f = setup();
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
          success: true,
          result: [{ id: 'other-zone', account: { id: 'other-account' } }],
        }),
      );
      await expect(saveToken(f.env, 'test-only-credential')).rejects.toThrow(
        'correct Cloudflare account',
      );
      expect(f.objects.has('system/provisioning-token')).toBe(false);
    } finally {
      f.close();
    }
  });

  it('redirects only configured legacy hosts and retains paths and query strings', async () => {
    const f = setup();
    try {
      f.env.REDIRECT_HOSTS = ' old.example.com, older.example.com ';
      const ctx = { waitUntil() {} } as unknown as ExecutionContext;
      const response = await fetchApi(
        new Request('https://old.example.com/inbox?q=hello'),
        f.env,
        ctx,
      );
      expect(response?.status).toBe(308);
      expect(response?.headers.get('location')).toBe(`${f.env.APP_ORIGIN}/inbox?q=hello`);
      expect(
        await fetchApi(new Request('https://unconfigured.example.com/'), f.env, ctx),
      ).toBeNull();
    } finally {
      f.close();
    }
  });
});

it('warns when routing rules access succeeds but Zone Settings Read is missing', async () => {
  const f = setup();
  try {
    f.env.CONFIG_ENCRYPTION_KEY = btoa('x'.repeat(32));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/zones'))
        return Response.json({
          success: true,
          result: [{ id: '11111111111111111111111111111111', account: { id: f.env.ACCOUNT_ID } }],
        });
      if (url.pathname.endsWith('/email/routing'))
        return Response.json(
          { success: false, errors: [{ message: 'Authentication error' }] },
          { status: 403 },
        );
      return Response.json({ success: true, result: [] });
    });
    const result = await saveToken(f.env, 'test-only-provisioning-credential');
    expect(result.warnings).toEqual([
      'Add Zone → Zone Settings → Read to the token for complete domain status checks.',
    ]);
    expect((await configuredEnv(f.env)).CF_API_TOKEN).toBe('test-only-provisioning-credential');
  } finally {
    f.close();
  }
});
