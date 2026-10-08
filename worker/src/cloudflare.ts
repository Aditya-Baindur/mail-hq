import { AppError, audit, now, uid, type Domain, type Env } from './model';
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
    throw new AppError(
      502,
      data.errors?.map((x) => x.message).join('; ') || 'Cloudflare could not complete the request.',
    );
  return data.result;
}
type Rule = {
  id: string;
  matchers: { type: string; field?: string; value?: string }[];
  actions: { type: string; value?: string[] }[];
};
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
  const routing = await api<{ enabled: boolean }>(env, `/zones/${d.id}/email/routing`);
  if (!routing.enabled)
    throw new AppError(409, 'Email Routing is not enabled. Existing DNS will not be changed.');
  const mx = await api<{ name: string; content: string }[]>(
    env,
    `/zones/${d.id}/dns_records?type=MX&name=${d.name}&per_page=100`,
  );
  if (!mx.length || mx.some((r) => !r.content.endsWith('.mx.cloudflare.net')))
    throw new AppError(409, 'This domain has an external mail provider. Its routing is protected.');
  for (let page = 1; ; page++) {
    const rules = await api<Rule[]>(
      env,
      `/zones/${d.id}/email/routing/rules?per_page=100&page=${page}`,
    );
    if (rules.some((r) => r.matchers.some((m) => m.value?.toLowerCase() === address)))
      throw new AppError(
        409,
        'This email address already has a routing rule. It will not be changed.',
      );
    if (rules.length < 100) break;
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
  try {
    const rule = await api<Rule>(env, `/zones/${d.id}/email/routing/rules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `Mail HQ: ${address}`,
        enabled: true,
        matchers: [{ type: 'literal', field: 'to', value: address }],
        actions: [{ type: 'worker', value: [env.EMAIL_WORKER_NAME] }],
        priority: 0,
      }),
    });
    await env.DB.prepare(
      "UPDATE mailboxes SET routing_rule_id=?,status='active',error=NULL WHERE id=?",
    )
      .bind(rule.id, id)
      .run();
    await audit(env, actor, 'mailbox.created', id, { address });
    return { id, address };
  } catch (error) {
    await env.DB.prepare("UPDATE mailboxes SET status='failed',error=? WHERE id=?")
      .bind(error instanceof Error ? error.message : 'Provisioning failed', id)
      .run();
    throw error;
  }
}
