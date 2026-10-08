import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { dashboardAuth } from '../worker/src/auth';
import { fetchApi } from '../worker/src/index';
import { setup } from './helpers';

let fixture: ReturnType<typeof setup>;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: Awaited<ReturnType<typeof exportJWK>>[] };
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256' }] };
});
beforeEach(() => {
  fixture = setup();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url) !== `${fixture.env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)
      throw new Error('Unexpected network request');
    return Response.json(jwks);
  });
});
afterEach(() => {
  fixture.close();
  vi.restoreAllMocks();
});

async function token(claims: JWTPayload = {}, signingKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: fixture.env.ACCESS_TEAM_DOMAIN,
    aud: [fixture.env.ACCESS_AUD],
    sub: 'verified-access-user',
    type: 'app',
    email: 'github-user@example.net',
    iat: now,
    exp: now + 300,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(signingKey);
}
function request(jwt: string) {
  return new Request('https://mail.example.com/api/bootstrap', {
    headers: { 'cf-access-jwt-assertion': jwt },
  });
}
describe('Cloudflare Access application sessions', () => {
  it.each(['github-user@example.net', 'owner@example.net'])(
    'accepts the Access-approved identity %s',
    async (email) => {
      const principal = await dashboardAuth(request(await token({ email })), fixture.env);
      expect(principal).toEqual({ actor: email, scopes: ['read', 'send'] });
    },
  );
  it('loads the dashboard API using the GitHub identity from its signed claims', async () => {
    const response = await fetchApi(request(await token()), fixture.env, {
      waitUntil() {},
    } as unknown as ExecutionContext);
    expect(response?.status).toBe(200);
    expect(((await response!.json()) as { identity: string }).identity).toBe(
      'github-user@example.net',
    );
  });
  it.each([
    { aud: ['another-access-app'] },
    { iss: 'https://another-team.cloudflareaccess.com' },
    { exp: 1 },
    { exp: undefined },
    { nbf: 9999999999 },
    { type: 'org' },
    { email: undefined, sub: '', common_name: 'service-token.access' },
  ])('rejects an invalid or non-user session: %j', async (claims) => {
    await expect(dashboardAuth(request(await token(claims)), fixture.env)).rejects.toThrow();
  });
  it('rejects a forged signature even when the claims name an approved identity', async () => {
    const attacker = await generateKeyPair('RS256');
    await expect(
      dashboardAuth(request(await token({}, attacker.privateKey)), fixture.env),
    ).rejects.toThrow();
  });
  it('rejects an email header without a signed Access application session', async () => {
    await expect(
      dashboardAuth(
        new Request('https://mail.example.com', {
          headers: { 'cf-access-authenticated-user-email': 'github-user@example.net' },
        }),
        fixture.env,
      ),
    ).rejects.toThrow();
  });
});
