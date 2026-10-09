import { z } from 'zod';
import { api, CloudflareApiError } from './cloudflare';
import { configuredEnv, decryptConfig, encryptConfig } from './settings';
import { AppError, audit, hash, limitedBody, rateLimit, type Env, type Principal } from './model';
import { cloudflareMx } from './dns';
import { receiveEmail } from './mail';
import { b64 } from './mime';

export const connectDomainSchema = z.object({
  zoneId: z.string().regex(/^[a-f0-9]{32}$/),
  token: z.string().trim().min(20).max(200),
});
type Credentials = { token: string; relaySecret: string };
type Connection = { domain_id: string; account_id: string; worker_name: string; credentials: string; ready: number };

export async function domainEnv(env: Env, domainId: string): Promise<Env> {
  const connection = await env.DB.prepare('SELECT * FROM domain_connections WHERE domain_id=?').bind(domainId).first<Connection>();
  if (!connection) return configuredEnv(env);
  if (!connection.ready) throw new AppError(409, 'Finish connecting this domain in Settings.');
  const credentials = await decryptConfig<Credentials>(env, domainId, connection.credentials);
  return { ...env, CF_API_TOKEN: credentials.token, ACCOUNT_ID: connection.account_id, EMAIL_WORKER_NAME: connection.worker_name };
}

// No public fetch handler: this Worker only accepts Cloudflare Email Routing events.
export function relaySource(endpoint: string) {
  return `const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export default { async email(message, env) {
  if (message.rawSize > 25 * 1024 * 1024) { message.setReject('Message exceeds 25 MB'); return; }
  const raw = await new Response(message.raw).arrayBuffer();
  const timestamp = String(Date.now());
  const digest = hex(await crypto.subtle.digest('SHA-256', raw));
  const payload = JSON.stringify([timestamp, message.from, message.to, digest]);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RELAY_SECRET), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const signature = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  const response = await fetch(${JSON.stringify(endpoint)}, { method:'POST', body:raw, redirect:'error', headers:{
    'content-type':'message/rfc822', 'x-mailhq-from':message.from, 'x-mailhq-to':message.to,
    'x-mailhq-time':timestamp, 'x-mailhq-signature':signature
  }});
  if (response.status === 404 || response.status === 413) { message.setReject('Mailbox unavailable or message too large'); return; }
  if (!response.ok) throw new Error('Mail HQ delivery unavailable');
}};`;
}

export async function connectDomain(env: Env, principal: Principal, input: z.infer<typeof connectDomainSchema>) {
  const owner = principal.userId!;
  await rateLimit(env, `domain-connect:${owner}`, 10);
  // Zone access proves control. Never accept an account ID or domain name supplied by the browser.
  const zone = await api<{ id: string; name: string; account: { id: string }; status: string }>(env, `/zones/${input.zoneId}`, {}, input.token);
  if (zone.id !== input.zoneId || !/^[a-f0-9]{32}$/.test(zone.account.id) || zone.status !== 'active')
    throw new AppError(400, 'Choose an active domain in your Cloudflare account.');
  const existing = await env.DB.prepare('SELECT owner_id FROM domains WHERE id=? OR name=?').bind(zone.id, zone.name).first<{ owner_id: string | null }>();
  if (existing && existing.owner_id !== owner) throw new AppError(409, 'This domain is already connected to another account.');
  // Complete all prerequisites before installing a relay. Never change MX or existing routes.
  const [routing, mx, sending] = await Promise.all([
    api<{ enabled: boolean }>(env, `/zones/${zone.id}/email/routing`, {}, input.token),
    api<{ content: string }[]>(env, `/zones/${zone.id}/dns_records?type=MX&name=${encodeURIComponent(zone.name)}&per_page=100`, {}, input.token),
    api<{ name: string; enabled: boolean }[]>(env, `/zones/${zone.id}/email/sending/subdomains`, {}, input.token),
    api(env, `/zones/${zone.id}/email/routing/rules?per_page=1`, {}, input.token),
  ]);
  if (!routing.enabled || !cloudflareMx(mx.map(r => r.content)))
    throw new AppError(409, 'Enable Cloudflare Email Routing for this domain first. Existing DNS and delivery have not been changed.');
  const sends = sending.some(s => s.enabled && s.name.toLowerCase() === zone.name.toLowerCase());
  const previous = await env.DB.prepare('SELECT * FROM domain_connections WHERE domain_id=?').bind(zone.id).first<Connection>();
  if (!previous && await env.DB.prepare('SELECT id FROM mailboxes WHERE domain_id=? LIMIT 1').bind(zone.id).first())
    throw new AppError(409, 'This domain already has hosted mailboxes. Manage its existing connection with the app owner.');
  const credentials: Credentials = previous
    ? { ...await decryptConfig<Credentials>(env, zone.id, previous.credentials), token: input.token }
    : { token: input.token, relaySecret: b64(crypto.getRandomValues(new Uint8Array(32))) };
  const encrypted = await encryptConfig(env, zone.id, credentials);
  const workerName = previous?.worker_name || `mailhq-${crypto.randomUUID().replaceAll('-', '')}`;
  // Atomic ownership reservation: another user racing to connect cannot overwrite it.
  await env.DB.prepare('INSERT OR IGNORE INTO domains(id,name,owner_id) VALUES(?,?,?)').bind(zone.id, zone.name, owner).run();
  const reserved = await env.DB.prepare('SELECT id FROM domains WHERE id=? AND owner_id=?').bind(zone.id, owner).first();
  if (!reserved) throw new AppError(409, 'This domain is already connected to another account.');
  await env.DB.prepare('INSERT OR IGNORE INTO domain_connections(domain_id,account_id,worker_name,credentials) VALUES(?,?,?,?)')
    .bind(zone.id, zone.account.id, workerName, encrypted).run();
  const saved = await env.DB.prepare('SELECT * FROM domain_connections WHERE domain_id=?').bind(zone.id).first<Connection>();
  // Concurrent setup attempts share the reserved relay identity and signing key.
  const savedCredentials = await decryptConfig<Credentials>(env, zone.id, saved!.credentials);
  const multipart = new FormData();
  multipart.set('metadata', JSON.stringify({ main_module: 'relay.js', compatibility_date: '2026-10-08',
    bindings: [{ type: 'secret_text', name: 'RELAY_SECRET', text: savedCredentials.relaySecret }],
    observability: { enabled: true, traces: { enabled: true } },
  }));
  multipart.set('relay.js', new Blob([relaySource(`https://${env.MCP_HOST}/inbound/${zone.id}`)], { type: 'application/javascript+module' }), 'relay.js');
  const uploaded = await fetch(`https://api.cloudflare.com/client/v4/accounts/${zone.account.id}/workers/scripts/${saved!.worker_name}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${input.token}` }, body: multipart, signal: AbortSignal.timeout(20000),
  });
  const uploadResult = await uploaded.json() as { success: boolean };
  if (!uploaded.ok || !uploadResult.success) throw new AppError(502, 'Could not install the email relay. Add Account → Workers Scripts → Edit permission and reconnect.');
  await env.DB.batch([
    env.DB.prepare('UPDATE domain_connections SET credentials=?,ready=1 WHERE domain_id=?')
      .bind(await encryptConfig(env, zone.id, { ...savedCredentials, token: input.token }), zone.id),
    env.DB.prepare("UPDATE domains SET receiving=1,sending=?,routing_mode='literal',note=? WHERE id=? AND owner_id=?")
      .bind(+sends, sends ? 'Connected to your Cloudflare account.' : 'Receiving ready. Enable Email Sending for this domain in Cloudflare, then reconnect.', zone.id, owner),
  ]);
  await audit(env, principal.actor, 'domain.connected', undefined, { domain: zone.name });
  return { id: zone.id, name: zone.name, sending: sends, workerName: saved!.worker_name };
}

export async function receiveRelay(request: Request, env: Env, domainId: string) {
  try {
    if (request.method !== 'POST') throw new AppError(405, 'Use POST');
    if (!/^[a-f0-9]{32}$/.test(domainId)) throw new AppError(404, 'Not found');
    const connection = await env.DB.prepare('SELECT * FROM domain_connections WHERE domain_id=? AND ready=1').bind(domainId).first<Connection>();
    if (!connection) throw new AppError(404, 'Not found');
    const timestamp = request.headers.get('x-mailhq-time') || '';
    const from = request.headers.get('x-mailhq-from') || '';
    const to = request.headers.get('x-mailhq-to') || '';
    const signature = request.headers.get('x-mailhq-signature') || '';
    if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 300000 || !/^[a-f0-9]{64}$/.test(signature) || from.length > 254 || to.length > 254)
      throw new AppError(401, 'Invalid relay signature');
    const raw = await limitedBody(request, 25 * 1024 * 1024);
    const { relaySecret } = await decryptConfig<Credentials>(env, domainId, connection.credentials);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(relaySecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, Uint8Array.from(signature.match(/../g)!, h => parseInt(h, 16)), new TextEncoder().encode(JSON.stringify([timestamp, from, to, await hash(raw.buffer as ArrayBuffer)])));
    if (!valid) throw new AppError(401, 'Invalid relay signature');
    const box = await env.DB.prepare("SELECT id FROM mailboxes WHERE domain_id=? AND address=? AND status='active'").bind(domainId, to.toLowerCase()).first();
    if (!box) throw new AppError(404, 'Mailbox unavailable');
    await receiveEmail({ to, from, raw: new Blob([raw.slice().buffer]).stream(), rawSize: raw.length,
      headers: new Headers(), setReject(reason: string) { throw new AppError(404, reason); },
      async forward() { throw new Error('Relay does not forward'); }, async reply() { throw new Error('Relay does not reply'); },
    }, env);
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json({ error: error instanceof AppError ? error.message : 'Delivery unavailable' }, { status: error instanceof AppError ? error.status : 503 });
  }
}

export async function sendDomainEmail(env: Env, domainId: string, message: EmailMessageBuilder) {
  const connection = await env.DB.prepare('SELECT * FROM domain_connections WHERE domain_id=?').bind(domainId).first<Connection>();
  if (!connection) return env.EMAIL.send(message);
  const sendingEnv = await domainEnv(env, domainId);
  const address = (value: string | EmailAddress) => typeof value === 'string' ? value : { address: value.email, name: value.name };
  const recipients = (value: string | EmailAddress | (string | EmailAddress)[] | undefined) => value === undefined ? undefined : Array.isArray(value) ? value.map(address) : address(value);
  const attachments = (message.attachments || []).map(a => ({ filename: a.filename, type: a.type, disposition: a.disposition, content_id: a.contentId, content: typeof a.content === 'string' ? a.content : b64(new Uint8Array(a.content instanceof ArrayBuffer ? a.content : a.content.buffer, a.content instanceof ArrayBuffer ? 0 : a.content.byteOffset, a.content.byteLength)) }));
  try {
    const result = await api<{ message_id?: string; delivered: string[]; queued: string[]; permanent_bounces: string[]; suppressed_recipients?: string[] }>(sendingEnv, `/accounts/${connection.account_id}/email/sending/send`, {
      method: 'POST', body: JSON.stringify({ from: address(message.from), to: recipients(message.to), cc: recipients(message.cc), bcc: recipients(message.bcc),
        subject: message.subject, text: message.text, html: message.html, headers: message.headers, attachments, reply_to: recipients(message.replyTo) }),
    });
    if (!Array.isArray(result.delivered) || !Array.isArray(result.queued) || !Array.isArray(result.permanent_bounces))
      throw new AppError(502, 'Sending confirmation was incomplete. Check delivery before resending.');
    if (result.permanent_bounces.length || result.suppressed_recipients?.length || !(result.delivered.length + result.queued.length)) {
      // Partial delivery must never be retried as a new message automatically.
      throw new AppError(502, 'One or more recipients were not accepted. Check delivery before resending.');
    }
    // Older API responses omit message_id; retain it when the provider supplies one.
    return { messageId: result.message_id || null };
  } catch (error) {
    if (error instanceof CloudflareApiError && [400, 401, 403, 404, 413, 429].includes(error.upstreamStatus))
      throw Object.assign(new Error(error.message), { code: 'E_REMOTE_REJECTED' });
    throw error;
  }
}
