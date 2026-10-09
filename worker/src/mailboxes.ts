import { api, CloudflareApiError } from './cloudflare';
import { AppError, mailbox, now, uid, type Env, type Mailbox } from './model';
import { domainEnv } from './personal-domains';

type RoutingRule = {
  id: string;
  matchers: { type: string; field?: string; value?: string }[];
  actions: { type: string; value?: string[] }[];
};
const retryMessage =
  'Deletion is incomplete. Delete this mailbox again to finish removing its data.';

function routingError(error: unknown) {
  if (error instanceof CloudflareApiError && error.permissionDenied)
    return new AppError(
      403,
      'Cloudflare could not remove this address’s routing rule. In Settings, connect a token with Zone → Email Routing Rules → Edit for this domain, then retry. Your stored mail has not been deleted.',
    );
  return error;
}

async function addressRule(env: Env, box: Mailbox): Promise<RoutingRule | null> {
  let rule: RoutingRule | undefined;
  try {
    if (box.routing_rule_id) {
      try {
        rule = await api<RoutingRule>(
          env,
          `/zones/${box.domain_id}/email/routing/rules/${encodeURIComponent(box.routing_rule_id)}`,
        );
      } catch (error) {
        if (error instanceof CloudflareApiError && error.upstreamStatus === 404) return null;
        throw error;
      }
    } else {
      // A previously interrupted creation may have added its rule before the
      // rule ID was saved. Find it without touching any other address.
      const matches: RoutingRule[] = [];
      for (let page = 1; ; page++) {
        const rules = await api<RoutingRule[]>(
          env,
          `/zones/${box.domain_id}/email/routing/rules?per_page=50&page=${page}`,
        );
        matches.push(
          ...rules.filter((r) =>
            r.matchers.some((m) => m.value?.toLowerCase() === box.address.toLowerCase()),
          ),
        );
        if (rules.length < 50) break;
      }
      if (matches.length > 1)
        throw new AppError(
          409,
          'This address has multiple routing rules. Review them in Cloudflare before deleting the mailbox.',
        );
      rule = matches[0];
    }
  } catch (error) {
    throw routingError(error);
  }
  if (!rule) return null;
  if (
    (box.routing_rule_id && rule.id !== box.routing_rule_id) ||
    rule.matchers.length !== 1 ||
    rule.matchers[0].type !== 'literal' ||
    rule.matchers[0].field !== 'to' ||
    rule.matchers[0].value?.toLowerCase() !== box.address.toLowerCase() ||
    rule.actions.length !== 1 ||
    rule.actions[0].type !== 'worker' ||
    rule.actions[0].value?.length !== 1 ||
    rule.actions[0].value[0] !== env.EMAIL_WORKER_NAME
  )
    throw new AppError(
      409,
      'This address’s delivery rule has changed outside Mail HQ. Review it in Cloudflare before deleting the mailbox. No mail or routing rules have been removed.',
    );
  const protectedRule = await env.DB.prepare(
    'SELECT address FROM protected_addresses WHERE routing_rule_id=?',
  )
    .bind(rule.id)
    .first();
  if (protectedRule)
    throw new AppError(
      409,
      'This address has a protected delivery rule and cannot be deleted here.',
    );
  return rule;
}

async function clearMailboxStorage(env: Env, id: string) {
  for (const prefix of [`mail/${id}/`, `uploads/${id}/`, `imap/${id}/`]) {
    for (;;) {
      // Restart at the beginning after each deletion; never skip a page as the
      // object list shrinks. The trailing slash isolates neighboring mailboxes.
      const page = await env.MAIL_STORE.list({ prefix, limit: 500 });
      if (page.objects.length)
        await env.MAIL_STORE.delete(page.objects.map((object) => object.key));
      else if (page.truncated) throw new Error('Storage listing was incomplete');
      if (!page.truncated) break;
    }
  }
}

export async function deleteMailbox(env: Env, actor: string, id: string, confirmation: string) {
  const box = await mailbox(env, id);
  if (confirmation.trim().toLowerCase() !== box.address.toLowerCase())
    throw new AppError(400, 'Type the full email address to confirm deletion.');
  if (
    await env.DB.prepare('SELECT address FROM protected_addresses WHERE address=?')
      .bind(box.address)
      .first()
  )
    throw new AppError(
      409,
      'This address has a protected delivery rule and cannot be deleted here.',
    );

  if (!box.deletion_started_at) {
    const domain = await env.DB.prepare('SELECT routing_mode FROM domains WHERE id=?')
      .bind(box.domain_id)
      .first<{ routing_mode: string }>();
    let routingEnv = env;
    let rule: RoutingRule | null = null;
    if (box.routing_rule_id || domain?.routing_mode !== 'managed') {
      routingEnv = await domainEnv(env, box.domain_id);
      if (!routingEnv.CF_API_TOKEN)
        throw new AppError(
          503,
          'Connect a Cloudflare provisioning token in Settings to remove this address’s routing rule. Your stored mail has not been deleted.',
        );
      rule = await addressRule(routingEnv, box);
    }
    // Inactive mailboxes reject new delivery, sending, mail-app sessions, and
    // agent requests before private data is removed.
    await env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(id).run();
    try {
      if (rule) {
        try {
          await api(
            routingEnv,
            `/zones/${box.domain_id}/email/routing/rules/${encodeURIComponent(rule.id)}`,
            { method: 'DELETE' },
          );
        } catch (error) {
          if (!(error instanceof CloudflareApiError && error.upstreamStatus === 404)) throw error;
        }
      }
    } catch (error) {
      await env.DB.prepare('UPDATE mailboxes SET status=? WHERE id=?').bind(box.status, id).run();
      throw routingError(error);
    }
    await env.DB.prepare(
      'UPDATE mailboxes SET routing_rule_id=NULL,deletion_started_at=?,error=? WHERE id=?',
    )
      .bind(now(), retryMessage, id)
      .run();
  }

  try {
    await clearMailboxStorage(env, id);
    await env.DB.batch([
      ...[
        'attachments',
        'messages',
        'drafts',
        'imap_entries',
        'imap_submissions',
        'agent_tokens',
        'mail_app_passwords',
        'oauth_connections',
      ].map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE mailbox_id=?`).bind(id)),
      env.DB.prepare('DELETE FROM mailboxes WHERE id=?').bind(id),
      env.DB.prepare(
        'INSERT INTO audit_events(id,mailbox_id,actor,action,detail) VALUES(?,?,?,?,?)',
      ).bind(uid(), id, actor, 'mailbox.deleted', JSON.stringify({ address: box.address })),
    ]);
  } catch {
    throw new AppError(503, retryMessage);
  }
  return { ok: true, id, address: box.address };
}
