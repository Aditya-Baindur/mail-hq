# Deploy Mail HQ

The public configuration contains no production account IDs, live database identifiers, existing addresses, or routing rules. Fresh migrations create an empty schema. Configuration in an existing installation is not changed by publishing this repository.

## Deploy button

Use the centered Deploy to Cloudflare button in the README. It opens [Cloudflare's repository deployment flow](https://developers.cloudflare.com/workers/platform/deploy-buttons/), clones this project, and provisions D1, R2, and KV. Enable R2 on your account first. Accept `npm run build` and `npm run deploy` for the build and deploy commands. Keep the lockfile.

The flow must replace the placeholder D1 database ID in `wrangler.jsonc`. Inspect that configuration in your clone. The deployment applies `migrations/` using the binding name `DB`, then uploads `dist/server/wrangler.json`. This output contains the compiled frontend and native Static Assets binding.

Initial requests are denied until Access is configured. Do not disable authentication to get past the initial 401 response.

## Domains and Access

1. Add a Worker custom domain for the dashboard, for example `mail.example.com`.
2. Add another custom domain for MCP, for example `mcp.mail.example.com`.
3. Create a Cloudflare Access self-hosted application protecting the dashboard hostname, including all paths. Attach an allow policy for your intended users. Use an existing identity provider or configure one.
4. Copy the Access application audience (AUD) and your Zero Trust team URL into the variables below.
5. Reflect both custom domains in the `routes` array in your cloned Wrangler configuration. Disable `workers_dev` after the custom domains work. Leave preview URLs disabled.

```json
"routes": [
  { "pattern": "mail.example.com", "custom_domain": true },
  { "pattern": "mcp.mail.example.com", "custom_domain": true }
]
```

| Variable | Value |
| --- | --- |
| `ACCOUNT_ID` | Your Cloudflare account ID |
| `APP_ORIGIN` | Exact dashboard origin, e.g. `https://mail.example.com` |
| `ACCESS_TEAM_DOMAIN` | Team URL, e.g. `https://your-team.cloudflareaccess.com` |
| `ACCESS_AUD` | Dashboard Access application's audience |
| `MCP_HOST` | MCP hostname without scheme or path |
| `EMAIL_WORKER_NAME` | Actual deployed Worker name |
| `REDIRECT_HOSTS` | Optional comma-separated old dashboard hostnames; also add their custom-domain routes |

The MCP hostname exposes OAuth discovery, registration and token endpoints, with mailbox-scoped bearer authentication on `/mcp`. Do not put interactive Access login in front of that hostname. The consent page lives at `APP_ORIGIN/oauth/authorize`, protected by the dashboard's Access policy. The dashboard independently verifies JWT signature, issuer, audience, expiry, and user-session claims.

Bind a private KV namespace as `OAUTH_KV`; Wrangler can provision the binding from the public template. For an existing installation, run `wrangler kv namespace create OAUTH_KV` with its config and record the returned namespace ID under `kv_namespaces`. Apply migration `0004_mcp_oauth.sql` and retain the `global_fetch_strictly_public` compatibility flag. OAuth needs no additional signing secret. See [OAuth client setup](mcp-oauth.md).

Generate the configuration-encryption secret locally:

```sh
openssl rand -base64 32
npx wrangler secret put CONFIG_ENCRYPTION_KEY
```

Paste the generated value into Wrangler's prompt. Never commit it. Keep it stable: replacing it without re-encrypting the provisioning token makes stored configuration unreadable. The deploy-button flow may ask for the same secret from `.dev.vars.example`.

Keep variable and route changes in Wrangler configuration; later deployments can overwrite dashboard-only settings. Build and deploy again after configuring these values.

## Email setup

Use a domain or dedicated subdomain you control and want to host on Cloudflare Email Routing. Enabling routing can require changing MX records, so inspect and preserve any existing provider first. Mail HQ itself never rewrites MX records or edits existing routing rules.

1. Enable Email Routing for the intended domain in Cloudflare and complete its DNS setup deliberately.
2. Enable Email Sending for that domain and complete the authentication DNS verification. Receiving availability does not automatically imply sending availability.
3. Create a restricted Cloudflare token for the intended account/zones with Zone Read, **Zone Settings Read**, DNS Read, Email Routing Rules Read/Write, and Email Sending Read. Zone Settings Read is a separate permission from Email Routing Rules and is required to read routing status. Use Cloudflare's current token permission names if the UI changes.
4. In Mail HQ Settings, connect the token, then refresh domains. It is encrypted in private R2 with `CONFIG_ENCRYPTION_KEY`.
5. Create a mailbox. Mail HQ checks for an existing literal routing rule before adding a new worker rule. It refuses conflicts and domains with external-provider MX records.

For domains already connected, **Refresh status** also works without a provisioning token: it checks public MX records through Cloudflare DNS, updates receiving status, and preserves the saved sending status. The UI identifies this as a receiving-only check. With a provisioning token, refresh checks Email Routing and Email Sending through the Cloudflare API and discovers accessible domains. When a connected token lacks routing-settings or DNS permission, receiving checks fall back to public DNS and show the exact permission needed. Sending is checked independently; a routing failure does not discard a successful sending check. Repeated permission notices are grouped. Failed checks retain the last saved value and show a retryable error beside Domains. Token connection reports missing read permissions without discarding an otherwise valid provisioning token. Refresh never modifies DNS or forwarding rules.

Creating a mailbox still requires Email Routing Rules Edit for its domain. If Zone Settings Read or DNS Read is unavailable, creation verifies current public MX records instead, then checks every page of existing routing rules before adding the new literal address. A confirmed disabled routing setting, external or unverified MX, or unreadable routing rules blocks creation. A denied rule write gives the required permission and releases the new pending reservation so the user can reconnect a token and retry. Uncertain write failures retain their reservation to prevent duplicate rules.

The `protected_addresses` table can reserve existing addresses explicitly. An optional managed catch-all mode supports provisioning without a stored Cloudflare token, but is an operator configuration: first preserve existing literal rules, reserve protected addresses, and point an intentionally available catch-all to the Worker. Do not set `routing_mode='managed'` merely to skip routing checks.

No catch-all or managed domain is enabled by the public migrations. Unknown recipients are rejected. Existing mailboxes at other providers are not imported.

## Manual deployment

Set the account and bindings in `wrangler.jsonc`, create D1/R2/KV resources if not using the button, and record their identifiers. Then:

```sh
npm ci
npm run cf:types
npm run typecheck
npm test
npm run deploy:local
```

For a separate existing installation, keep its complete configuration in ignored `wrangler.production.jsonc` and use `npm run build:production` / `npm run deploy:production`. The public template cannot target that account by default. These commands retain that installation's resource names and routes; Wrangler retains existing secrets unless explicitly changed.

`scripts/package-mcp-deploy.mjs` is an alternative packager for Cloudflare API uploads in restricted environments. It only writes a local bundle; it does not upload it. It embeds static assets behind the same Access check and declares `keep_bindings: ['secret_text']`. Use the selected installation's build output and inspect bindings before an upload.

## Verify

- Unauthenticated dashboard requests reach Access; invalid JWTs fail at the Worker.
- An allowed user's signed session can open the dashboard and API.
- Requests to MCP without a token return 401 with OAuth discovery. Approval, refresh and revocation work; a token sees exactly its mailbox and selected tools.
- A new mailbox receives a real message and can send a reply with an attachment.
- Review the received message's SPF, DKIM, and DMARC results. Provider acceptance is not proof of inbox placement.
- Existing addresses, MX records, and routing rules are unchanged.
- D1 migrations are applied and R2 has no public bucket access.

A successful build verifies packaging, not domain ownership, mail delivery, or Access policy correctness. Those must be verified in the target account.
