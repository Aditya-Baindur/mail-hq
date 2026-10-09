import type { Env } from './model';

// A write already in flight can finish uploading after deletion's storage
// sweep. Discard its objects when the mailbox no longer accepts mail.
export async function discardInactiveMailboxWrites(env: Env, id: string, keys: string[]) {
  const active = await env.DB.prepare("SELECT id FROM mailboxes WHERE id=? AND status='active'")
    .bind(id)
    .first();
  if (active) return false;
  for (let offset = 0; offset < keys.length; offset += 500)
    await env.MAIL_STORE.delete(keys.slice(offset, offset + 500));
  return true;
}
