# Deploy Mail HQ

The public configuration contains no production account IDs, live database identifiers, existing addresses, or routing rules. Fresh migrations create an empty schema. Configuration in an existing installation is not changed by publishing this repository.

## Deploy button

Use the centered Deploy to Cloudflare button in the README. It opens [Cloudflare's repository deployment flow](https://developers.cloudflare.com/workers/platform/deploy-buttons/), clones this project, and provisions D1 and R2. Enable R2 on your account first. Accept `npm run build` and `npm run deploy` for the build and deploy commands. Keep the lockfile.

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

The MCP hostname uses its own mailbox-scoped bearer authentication. Do not put interactive Access login in front of that hostname. It returns an authentication error without a valid mailbox token. The dashboard verifies the JWT signature, issuer, audience, expiry, and user-session claims independently of the edge policy.

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
3. Create a restricted Cloudflare token for the intended account/zones with Zone Read, DNS Read, Email Routing Rules Read/Write, and Email Sending Read. Use Cloudflare's current token permission names if the UI changes.
4. In Mail HQ Settings, connect the token, then refresh domains. It is encrypted in private R2 with `CONFIG_ENCRYPTION_KEY`.
5. Create a mailbox. Mail HQ checks for an existing literal routing rule before adding a new worker rule. It refuses conflicts and domains with external-provider MX records.

The `protected_addresses` table can reserve existing addresses explicitly. An optional managed catch-all mode supports provisioning without a stored Cloudflare token, but is an operator configuration: first preserve existing literal rules, reserve protected addresses, and point an intentionally available catch-all to the Worker. Do not set `routing_mode='managed'` merely to skip routing checks.

No catch-all or managed domain is enabled by the public migrations. Unknown recipients are rejected. Existing mailboxes at other providers are not imported.

## Manual deployment

Set the account and bindings in `wrangler.jsonc`, create D1/R2 resources if not using the button, and record the real database ID. Then:

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
- Requests to MCP without a token fail; a token sees exactly its mailbox and selected tools.
- A new mailbox receives a real message and can send a reply with an attachment.
- Review the received message's SPF, DKIM, and DMARC results. Provider acceptance is not proof of inbox placement.
- Existing addresses, MX records, and routing rules are unchanged.
- D1 migrations are applied and R2 has no public bucket access.

A successful build verifies packaging, not domain ownership, mail delivery, or Access policy correctness. Those must be verified in the target account.
