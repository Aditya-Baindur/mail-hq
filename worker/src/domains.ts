import { api, CloudflareApiError } from './cloudflare';
import { AppError, now, type Domain, type Env } from './model';
import { configuredEnv } from './settings';
import { cloudflareMx, normalizeHost, receivingDns } from './dns';

export { receivingDns } from './dns';

const externalNote = 'External mail routing detected. Existing delivery is preserved.';

type CheckIssue = { domain: string; message: string };
type Zone = { id: string; name: string; account?: { id: string } };

function checkWarning(error: unknown, check: string, permission: string, fallback: string) {
  return error instanceof CloudflareApiError && error.permissionDenied
    ? `Cloudflare denied ${check}. Add ${permission} to the token for these domains. ${fallback}`
    : `Cloudflare could not verify ${check}. ${fallback}`;
}

export async function syncDomains(originalEnv: Env) {
  const saved = (await originalEnv.DB.prepare('SELECT * FROM domains WHERE id NOT IN (SELECT domain_id FROM domain_connections) ORDER BY name').all<Domain>())
    .results;
  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];
  let env = originalEnv;
  try {
    env = await configuredEnv(originalEnv);
  } catch {
    warnings.push({
      domain: '',
      message:
        'The saved Cloudflare token could not be read. Reconnect it in Settings. Receiving will be checked using DNS.',
    });
  }
  let zones: Zone[] = saved;
  if (env.CF_API_TOKEN) {
    const discovered: Zone[] = [];
    try {
      for (let page = 1; ; page++) {
        const batch = await api<Zone[]>(
          env,
          `/zones?account.id=${env.ACCOUNT_ID}&per_page=50&page=${page}`,
        );
        discovered.push(...batch.filter((zone) => zone.account?.id === env.ACCOUNT_ID));
        if (batch.length < 50) break;
      }
      // Restricted tokens may only see some of the saved domains. Keep checking
      // the others through DNS rather than silently leaving them stale.
      zones = Array.from(
        new Map([...saved, ...discovered].map((zone) => [zone.id, zone])).values(),
      );
    } catch (error) {
      warnings.push({
        domain: '',
        message: checkWarning(
          error,
          'domain discovery',
          'Zone → Zone → Read',
          'Existing domains will still be checked. New domains could not be discovered.',
        ),
      });
    }
  }
  if (!zones.length)
    throw new AppError(
      400,
      warnings[0]?.message || 'Connect a Cloudflare token above to discover your domains first.',
    );

  let updated = 0;
  let receivingChecked = 0;
  let sendingChecked = 0;
  let usedDns = !env.CF_API_TOKEN;
  for (const zone of zones) {
    if (await env.DB.prepare('SELECT domain_id FROM domain_connections WHERE domain_id=?').bind(zone.id).first()) continue;
    const previous = saved.find((domain) => domain.id === zone.id);
    let receiving: number | undefined;
    let sending: number | undefined;
    let note = previous?.note ?? 'Receiving status has not been verified yet.';
    let routing: PromiseSettledResult<{ enabled: boolean }> | undefined;
    let mx: PromiseSettledResult<{ content: string }[]> | undefined;
    if (env.CF_API_TOKEN) {
      const checks = await Promise.allSettled([
        api<{ enabled: boolean }>(env, `/zones/${zone.id}/email/routing`),
        api<{ content: string }[]>(
          env,
          `/zones/${zone.id}/dns_records?type=MX&name=${encodeURIComponent(zone.name)}&per_page=100`,
        ),
        api<{ name: string; enabled: boolean }[]>(
          env,
          `/zones/${zone.id}/email/sending/subdomains`,
        ),
      ]);
      [routing, mx] = checks;
      const sendingResult = checks[2];
      if (sendingResult.status === 'fulfilled') {
        sending = +sendingResult.value.some(
          (domain) => normalizeHost(domain.name) === normalizeHost(zone.name) && domain.enabled,
        );
      } else {
        warnings.push({
          domain: zone.name,
          message: checkWarning(
            sendingResult.reason,
            'sending status',
            'Email Sending → Read',
            'Sending was not checked; the saved status has been kept.',
          ),
        });
      }
      if (routing.status === 'fulfilled' && mx.status === 'fulfilled') {
        receiving = +(
          routing.value.enabled && cloudflareMx(mx.value.map((record) => record.content))
        );
        note = receiving
          ? previous?.routing_mode === 'managed'
            ? 'New mailboxes are ready. Existing forwarding addresses are protected.'
            : 'Email Routing is ready. Existing forwarding rules are unchanged.'
          : externalNote;
      } else {
        if (routing.status === 'rejected')
          warnings.push({
            domain: zone.name,
            message: checkWarning(
              routing.reason,
              'routing settings',
              'Zone → Zone Settings → Read',
              'Receiving is checked using public DNS where possible.',
            ),
          });
        if (mx.status === 'rejected')
          warnings.push({
            domain: zone.name,
            message: checkWarning(
              mx.reason,
              'DNS records',
              'Zone → DNS → Read',
              'Receiving is checked using public DNS where possible.',
            ),
          });
      }
    }
    if (receiving === undefined) {
      usedDns = true;
      try {
        const result = await receivingDns(zone.name);
        // A successful routing check that says disabled remains authoritative.
        // DNS fallback must not override it with a false ready state.
        receiving = +(
          result.receiving && !(routing?.status === 'fulfilled' && !routing.value.enabled)
        );
        note =
          routing?.status === 'fulfilled' && !routing.value.enabled
            ? 'Cloudflare Email Routing is disabled. Existing delivery is unchanged.'
            : result.receiving
              ? 'Receiving DNS points to Cloudflare. Existing forwarding rules are unchanged.'
              : result.hasMx
                ? externalNote
                : 'No mail receiving records were found for this domain.';
      } catch (error) {
        errors.push({
          domain: zone.name,
          message:
            error instanceof Error
              ? error.message
              : 'Receiving could not be checked. The saved status has been kept.',
        });
      }
    }
    if (receiving === undefined && sending === undefined) continue;
    try {
      // Save each independently verified value even if the other check failed.
      await env.DB.prepare(
        'INSERT INTO domains(id,name,receiving,sending,note) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,receiving=excluded.receiving,sending=excluded.sending,note=excluded.note',
      )
        .bind(
          zone.id,
          zone.name,
          receiving ?? previous?.receiving ?? 0,
          sending ?? previous?.sending ?? 0,
          note,
        )
        .run();
      updated++;
      if (receiving !== undefined) receivingChecked++;
      if (sending !== undefined) sendingChecked++;
    } catch {
      errors.push({
        domain: zone.name,
        message: 'The refreshed status could not be saved. Try again.',
      });
    }
  }
  const domains = (
    await env.DB.prepare('SELECT * FROM domains WHERE id NOT IN (SELECT domain_id FROM domain_connections) ORDER BY receiving DESC,name').all<Domain>()
  ).results;
  const source = !env.CF_API_TOKEN ? 'dns' : usedDns ? 'mixed' : 'cloudflare';
  return {
    domains,
    updated,
    total: zones.length,
    source,
    receivingChecked,
    sendingChecked,
    errors,
    warnings,
    checkedAt: now(),
  };
}
