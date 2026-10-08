import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError, hash, now, rateLimit, type Env, type Principal } from './model';
const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function dashboardAuth(request: Request, env: Env): Promise<Principal> {
  const url = new URL(request.url);
  if (env.LOCAL_DEV === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname))
    return { actor: 'local-development', scopes: ['read', 'send'] };
  if (url.origin !== env.APP_ORIGIN) throw new AppError(403, 'Use the protected Mail HQ address.');
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || !env.ACCESS_AUD) throw new AppError(401, 'Sign in through Cloudflare Access.');
  try {
    const issuer = env.ACCESS_TEAM_DOMAIN;
    if (!keysets.has(issuer))
      keysets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
    const { payload } = await jwtVerify(token, keysets.get(issuer)!, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub'],
    });
    // Access issues this app-specific token after the user's configured policies
    // allow the login. Do not duplicate those policies with a hardcoded email.
    if (
      payload.type !== 'app' ||
      typeof payload.email !== 'string' ||
      !payload.email.trim() ||
      !payload.sub
    )
      throw new Error('An Access-approved user session is required');
    return { actor: payload.email, scopes: ['read', 'send'] };
  } catch {
    throw new AppError(401, 'Your session has expired. Sign in again.');
  }
}
export function checkOrigin(request: Request, env: Env) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  const url = new URL(request.url);
  if (
    origin !== env.APP_ORIGIN &&
    !(
      env.LOCAL_DEV === 'true' &&
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      origin === url.origin
    )
  )
    throw new AppError(403, 'Request origin is not allowed.');
}
export async function agentAuth(request: Request, env: Env): Promise<Principal> {
  const token = request.headers
    .get('authorization')
    ?.match(/^Bearer (mhq_[A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new AppError(401, 'A mailbox access token is required.');
  await rateLimit(
    env,
    `mcp-ip:${await hash(request.headers.get('cf-connecting-ip') || 'local')}`,
    240,
  );
  const row = await env.DB.prepare(
    'SELECT t.*,m.status AS mailbox_status FROM agent_tokens t JOIN mailboxes m ON m.id=t.mailbox_id WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?',
  )
    .bind(await hash(token), now())
    .first<{ id: string; mailbox_id: string; scopes: string; mailbox_status: string }>();
  if (!row || row.mailbox_status !== 'active')
    throw new AppError(401, 'This token has expired, was revoked, or its mailbox is inactive.');
  await rateLimit(env, `mcp:${row.id}`, 120);
  await env.DB.prepare('UPDATE agent_tokens SET last_used_at=? WHERE id=?')
    .bind(now(), row.id)
    .run();
  return { actor: `agent:${row.id}`, mailboxId: row.mailbox_id, scopes: JSON.parse(row.scopes) };
}
