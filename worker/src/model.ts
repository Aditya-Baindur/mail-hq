export type Env = {
  [K in keyof Cloudflare.Env]: Cloudflare.Env[K] extends string ? string : Cloudflare.Env[K];
} & {
  CF_API_TOKEN?: string;
  CONFIG_ENCRYPTION_KEY?: string;
  LOCAL_DEV?: string;
  REDIRECT_HOSTS?: string;
};
export type Mailbox = {
  id: string;
  domain_id: string;
  address: string;
  name: string;
  color: string;
  status: string;
  routing_rule_id: string | null;
  error: string | null;
  created_at: string;
};
export type Domain = {
  id: string;
  name: string;
  receiving: number;
  sending: number;
  note: string | null;
  routing_mode: 'literal' | 'managed';
};
export type Message = {
  id: string;
  mailbox_id: string;
  thread_id: string;
  direction: 'inbound' | 'outbound';
  folder: string;
  sender: string;
  sender_name: string;
  recipients: string;
  cc: string;
  bcc: string;
  reply_to: string | null;
  subject: string;
  snippet: string;
  body_key: string;
  raw_key: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  refs: string;
  is_read: number;
  starred: number;
  status: string;
  error: string | null;
  size: number;
  created_at: string;
};
export type Attachment = {
  id: string;
  mailbox_id: string;
  message_id: string | null;
  filename: string;
  content_type: string;
  size: number;
  object_key: string;
  content_id: string | null;
};
export type Principal = { actor: string; mailboxId?: string; scopes: ('read' | 'send')[] };
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export async function hash(value: string | ArrayBuffer) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        typeof value === 'string' ? new TextEncoder().encode(value) : value,
      ),
    ),
  )
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export async function audit(
  env: Env,
  actor: string,
  action: string,
  mailboxId?: string,
  detail: Record<string, unknown> = {},
) {
  await env.DB.prepare(
    'INSERT INTO audit_events(id,mailbox_id,actor,action,detail) VALUES(?,?,?,?,?)',
  )
    .bind(uid(), mailboxId || null, actor, action, JSON.stringify(detail))
    .run();
}
export function scope(p: Principal, mailboxId: string, permission: 'read' | 'send' = 'read') {
  if (p.mailboxId && p.mailboxId !== mailboxId) throw new AppError(404, 'Not found');
  if (!p.scopes.includes(permission))
    throw new AppError(403, `This connection does not have ${permission} access.`);
}
export async function mailbox(env: Env, id: string) {
  const row = await env.DB.prepare('SELECT * FROM mailboxes WHERE id=?').bind(id).first<Mailbox>();
  if (!row) throw new AppError(404, 'Mailbox not found');
  return row;
}
export async function limitedBody(request: Request, max = 1_000_000) {
  if (Number(request.headers.get('content-length')) > max)
    throw new AppError(413, 'Request is too large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new AppError(413, 'Request is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
}
export async function rateLimit(env: Env, key: string, limit: number, seconds = 60) {
  const window = Math.floor(Date.now() / 1000 / seconds);
  const r = await env.DB.prepare(
    'INSERT INTO rate_limits(key,count,window) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count',
  )
    .bind(key, window)
    .first<{ count: number }>();
  if (r && r.count > limit) throw new AppError(429, 'Too many requests. Please try again shortly.');
}
