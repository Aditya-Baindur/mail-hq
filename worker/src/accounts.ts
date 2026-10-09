import { AppError, type Env, type Principal } from './model';

// Access has already verified the email claim. Never derive ownership from a
// request body/header, or award legacy data to the first visitor.
export async function accountPrincipal(env: Env, principal: Principal): Promise<Principal> {
  const id = principal.actor.trim().toLowerCase();
  const local = env.LOCAL_DEV === 'true' && id === 'local-development';
  const isAdmin = local || (!!env.OWNER_EMAIL && id === env.OWNER_EMAIL.trim().toLowerCase());
  await env.DB.prepare('INSERT OR IGNORE INTO users(id) VALUES(?)').bind(id).run();
  if (isAdmin) {
    await env.DB.batch([
      env.DB.prepare('UPDATE mailboxes SET owner_id=? WHERE owner_id IS NULL').bind(id),
      env.DB.prepare('UPDATE domains SET owner_id=? WHERE owner_id IS NULL').bind(id),
    ]);
  }
  return { ...principal, actor: id, userId: id, isAdmin };
}
export function requireAdmin(principal: Principal) {
  if (!principal.isAdmin) throw new AppError(403, 'Only the app owner can change shared infrastructure.');
}
export async function ownedResource(env: Env, principal: Principal,
  table: 'drafts' | 'agent_tokens' | 'mail_app_passwords', id: string) {
  const row = await env.DB.prepare(`SELECT r.mailbox_id FROM ${table} r JOIN mailboxes b ON b.id=r.mailbox_id WHERE r.id=? AND b.owner_id=?`)
    .bind(id, principal.userId!).first<{ mailbox_id: string }>();
  if (!row) throw new AppError(404, 'Not found');
  return row;
}
