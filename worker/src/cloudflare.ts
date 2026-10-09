import { AppError, audit, uid, type Domain, type Env } from './model';
import { cloudflareMx, receivingDns } from './dns';
export class CloudflareApiError extends AppError {
  constructor(
    public upstreamStatus: number,
    message: string,
  ) {
    super(502, message);
  }
  get permissionDenied() {
    return (
      [401, 403].includes(this.upstreamStatus) ||
      /authentication error|unauthorized|permission denied/i.test(this.message)
    );
  }
}
export async function api<T>(
  env: Env,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const credential = token || env.CF_API_TOKEN;
  if (!credential)
    throw new AppError(
      503,
      'Connect a Cloudflare provisioning token in Settings to create mailboxes.',
    );
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const data = (await response.json()) as {
    success: boolean;
    result: T;
    errors: { message: string }[];
  };
  if (!response.ok || !data.success)
    throw new CloudflareApiError(
      response.status,
      data.errors?.map((x) => x.message).join('; ') || 'Cloudflare could not complete the request.',
    );
  return data.result;
}
type Rule = {
  id: string;
  matchers: { type: string; field?: string; value?: string }[];
  actions: { type: string; value?: string[] }[];
};

function routingPermissionError(domain: string) {
  return new AppError(
    403,
    `Cloudflare denied access to routing rules for ${domain}. In Settings, connect a token with Zone → Email Routing Rules → Edit and access to this domain, then try again.`,
  );
}

async function verifyReceiving(env: Env, domain: Domain) {
  let settingsReadable = true;
  try {
    const routing = await api<{ enabled: boolean }>(env, `/zones/${domain.id}/email/routing`);
    if (!routing.enabled)
      throw new AppError(409, 'Email Routing is not enabled. Existing DNS will not be changed.');
  } catch (error) {
    if (!(error instanceof CloudflareApiError && error.permissionDenied)) throw error;
    // Zone Settings Read is separate from permission to create routing rules.
    // Require current public MX and a successful rule conflict check instead.
    settingsReadable = false;
  }

  let receiving: boolean | undefined;
  if (settingsReadable) {
    try {
      const mx = await api<{ content: string }[]>(
        env,
        `/zones/${domain.id}/dns_records?type=MX&name=${encodeURIComponent(domain.name)}&per_page=100`,
      );
      receiving = cloudflareMx(mx.map((record) => record.content));
    } catch (error) {
      if (!(error instanceof CloudflareApiError && error.permissionDenied)) throw error;
    }
  }
  if (receiving === undefined) {
    try {
      receiving = (await receivingDns(domain.name)).receiving;
    } catch {
      throw new AppError(
        503,
        'Could not verify this domain’s mail DNS. Try creating the mailbox again.',
      );
    }
  }
  if (!receiving)
    throw new AppError(
      409,
      'This domain is not receiving mail through Cloudflare. Its existing routing is protected.',
    );
}

export async function provision(
  env: Env,
  actor: string,
  input: { localPart: string; domainId: string; name: string; color: string },
) {
  const d = await env.DB.prepare('SELECT * FROM domains WHERE id=?')
    .bind(input.domainId)
    .first<Domain>();
  if (!d) throw new AppError(400, 'Choose a connected domain');
  if (!d.receiving) throw new AppError(409, d.note || 'This domain uses another mail provider.');
  const address = `${input.localPart.toLowerCase()}@${d.name}`;
  const protectedAddress = await env.DB.prepare(
    'SELECT address FROM protected_addresses WHERE address=?',
  )
    .bind(address)
    .first();
  if (protectedAddress) throw new AppError(409, 'This existing address is protected.');
  if (d.routing_mode === 'managed') {
    const id = uid();
    try {
      await env.DB.prepare(
        "INSERT INTO mailboxes(id,domain_id,address,name,color,status) VALUES(?,?,?,?,?,'active')",
      )
        .bind(id, d.id, address, input.name || input.localPart, input.color)
        .run();
    } catch {
      throw new AppError(409, 'This mailbox already exists.');
    }
    await audit(env, actor, 'mailbox.created', id, { address });
    return { id, address };
  }
  await verifyReceiving(env, d);
  // Cloudflare caps Email Routing rule pages at 50, regardless of larger requests.
  const perPage = 50;
  for (let page = 1; ; page++) {
    let rules: Rule[];
    try {
      rules = await api<Rule[]>(
        env,
        `/zones/${d.id}/email/routing/rules?per_page=${perPage}&page=${page}`,
      );
    } catch (error) {
      if (error instanceof CloudflareApiError && error.permissionDenied)
        throw routingPermissionError(d.name);
      throw error;
    }
    if (rules.some((r) => r.matchers.some((m) => m.value?.toLowerCase() === address)))
      throw new AppError(
        409,
        'This email address already has a routing rule. It will not be changed.',
      );
    if (rules.length < perPage) break;
  }
  const id = uid();
  try {
    await env.DB.prepare(
      'INSERT INTO mailboxes(id,domain_id,address,name,color,status) VALUES(?,?,?,?,?,?)',
    )
      .bind(id, d.id, address, input.name || input.localPart, input.color, 'provisioning')
      .run();
  } catch {
    throw new AppError(409, 'This address is already provisioned or awaiting setup.');
  }
  let rule: Rule;
  try {
    rule = await api<Rule>(env, `/zones/${d.id}/email/routing/rules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `Mail HQ: ${address}`,
        enabled: true,
        matchers: [{ type: 'literal', field: 'to', value: address }],
        actions: [{ type: 'worker', value: [env.EMAIL_WORKER_NAME] }],
        priority: 0,
      }),
    });
  } catch (error) {
    if (error instanceof CloudflareApiError && error.permissionDenied) {
      // A rejected write created no rule. Release only this pending reservation
      // so reconnecting a valid token and retrying does not hit a duplicate.
      await env.DB.prepare(
        "DELETE FROM mailboxes WHERE id=? AND status='provisioning' AND routing_rule_id IS NULL",
      )
        .bind(id)
        .run();
      throw routingPermissionError(d.name);
    }
    await env.DB.prepare("UPDATE mailboxes SET status='failed',error=? WHERE id=?")
      .bind(error instanceof Error ? error.message : 'Provisioning failed', id)
      .run();
    throw error;
  }
  await env.DB.prepare(
    "UPDATE mailboxes SET routing_rule_id=?,status='active',error=NULL WHERE id=?",
  )
    .bind(rule.id, id)
    .run();
  await audit(env, actor, 'mailbox.created', id, { address });
  return { id, address };
}
