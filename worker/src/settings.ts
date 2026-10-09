import { api, CloudflareApiError } from './cloudflare';
import { AppError, type Env } from './model';
async function key(env: Env) {
  if (!env.CONFIG_ENCRYPTION_KEY)
    throw new AppError(503, 'Provisioning storage is not configured.');
  return crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(env.CONFIG_ENCRYPTION_KEY), (c) => c.charCodeAt(0)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}
export async function saveToken(env: Env, token: string) {
  const zones = await api<{ id: string; account: { id: string } }[]>(
    env,
    '/zones?per_page=50',
    {},
    token,
  );
  const zone = zones.find((z) => z.account.id === env.ACCOUNT_ID);
  if (!zone) throw new AppError(400, 'This token cannot access the correct Cloudflare account.');
  await api(env, `/zones/${zone.id}/email/routing/rules?per_page=1`, {}, token);
  const checks = [
    { path: `/zones/${zone.id}/email/routing`, permission: 'Zone → Zone Settings → Read' },
    { path: `/zones/${zone.id}/dns_records?type=MX&per_page=1`, permission: 'Zone → DNS → Read' },
    { path: `/zones/${zone.id}/email/sending/subdomains`, permission: 'Email Sending → Read' },
  ];
  const results = await Promise.allSettled(checks.map((check) => api(env, check.path, {}, token)));
  const warnings = results.flatMap((result, index) =>
    result.status === 'fulfilled'
      ? []
      : [
          result.reason instanceof CloudflareApiError && result.reason.permissionDenied
            ? `Add ${checks[index].permission} to the token for complete domain status checks.`
            : `Could not verify ${checks[index].permission} access. Domain refresh will retry this check.`,
        ],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await key(env),
    new TextEncoder().encode(token),
  );
  const bytes = new Uint8Array(iv.length + encrypted.byteLength);
  bytes.set(iv);
  bytes.set(new Uint8Array(encrypted), iv.length);
  await env.MAIL_STORE.put('system/provisioning-token', bytes);
  return { warnings };
}
export async function configuredEnv(env: Env): Promise<Env> {
  if (env.CF_API_TOKEN) return env;
  const object = await env.MAIL_STORE.get('system/provisioning-token');
  if (!object) return env;
  const bytes = new Uint8Array(await object.arrayBuffer());
  const decoded = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) },
    await key(env),
    bytes.slice(12),
  );
  return { ...env, CF_API_TOKEN: new TextDecoder().decode(decoded) };
}
