<h1 align="center">Mail HQ</h1>
<p align="center">Your email. Your domains. Your agents.</p>
<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/Aditya-Baindur/mail-hq">
    <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" />
  </a>
</p>

A minimal email workspace built with Next.js, shadcn/ui, and Cloudflare Workers. Create mailboxes on your domains, send and receive formatted email, and give an AI agent access to exactly one inbox.

## What you get

- A clean, responsive inbox with searchable mailbox selectors and keyboard controls.
- Unified and individual inboxes, threads, replies, forwarding, search, stars, archive, and trash.
- Rich text composition, attachments, and automatically saved drafts.
- Mailbox management and a stats view for mail, storage, and agent activity.
- Private R2 storage for attachments, message bodies, and original incoming MIME; D1 for metadata.
- Private user accounts with Cloudflare Access login and isolated mailboxes, mail, drafts, and connections.
- Personal domains kept in each user’s Cloudflare account, with a guided connection flow.
- A hosted MCP server with OAuth sign-in, mailbox selection, read/send permissions, and revocable connections.

## Deploy your own

Click **Deploy to Cloudflare** above. Cloudflare clones this repository and provisions D1, R2, and an OAuth KV namespace in **your** account. Enable R2 first, use `npm run build` as the build command, and `npm run deploy` as the deploy command. The deploy command applies database migrations using the `DB` binding before deploying the Vite output.

**The button deploys the application; you still need to configure your domains, Cloudflare Access, Email Routing, and Email Sending.** The app stays locked until Access is configured. It does not take over existing mail routes or MX records.

Follow the [deployment guide](docs/deployment.md) to:

1. Connect a dashboard hostname and a separate MCP hostname to the Worker.
2. Create an Access application for the dashboard and set the application audience and team URL.
3. Enable Email Routing and Email Sending for a domain you intend to use with Mail HQ.
4. Connect a restricted provisioning token, refresh domains, and create your first mailbox.

Cloudflare resource usage and sending availability depend on your account and plan. An email domain already using another provider is kept unavailable for provisioning until you explicitly migrate it.

## Invite users and connect personal domains

Set `OWNER_EMAIL` to your Cloudflare Access sign-in email before upgrading, and apply all migrations. Existing mailboxes and domains are assigned to that identity when the owner signs in; other users start with an empty private workspace.

Allow users’ emails in your dashboard’s Cloudflare Access policy and share the app URL. Under **Settings → Connect your domain**, each user connects a domain from their own Cloudflare account using its Zone ID and a scoped API token. Mail HQ installs an inbound relay Worker there and uses that account for outbound sending. Enable Cloudflare Email Routing and Email Sending first. The connection flow preserves existing DNS and address routes.

See [multi-user setup and personal domains](docs/accounts.md) for permissions, upgrade steps, and connection repair.

## Connect an agent

Add your MCP URL to ChatGPT, Codex, or Cursor and use **OAuth** authentication. Sign in through your existing Mail HQ login, choose the exact mailbox, and approve read and/or send access. No pasted mailbox password or client secret is needed. Revoke connections under **Agents**.

```json
{
  "mcpServers": {
    "mail-hq": {
      "url": "https://mcp.mail.example.com/mcp"
    }
  }
}
```

See [client setup and OAuth operation](docs/mcp-oauth.md) for all three apps. Clients use Streamable HTTP with OAuth discovery and PKCE. Connections expire after 30 days; access tokens refresh automatically. Existing manual mailbox tokens still work for scripts and clients requiring a custom `Authorization: Bearer ...` header.

| Permission | Tools |
| --- | --- |
| Read | `get_mailbox`, `list_mail`, `read_mail`, `read_attachment` |
| Send | `send_mail`, `reply_to_mail` |

Agents cannot select a different mailbox or sender. Sending requires a UUID `idempotencyKey`; reuse it when retrying the same request. Treat received email and attachments as untrusted content, including instructions embedded in messages.

## Run locally

Use Node.js 22.13 or newer (Node.js 24 LTS is recommended).

```sh
npm ci
cp .dev.vars.example .dev.vars
# Add LOCAL_DEV=true to .dev.vars for localhost-only development.
npm run db:local
npm run dev
```

The initial database is empty. Development bypasses Access only on `localhost` or `127.0.0.1` with `LOCAL_DEV=true`. Never set that variable in production. Unit tests use isolated database/storage fixtures and mock email sending.

```sh
npm run typecheck
npm test
npm run build
```

For manual deployment after configuring `wrangler.jsonc` and provisioning its resources:

```sh
npm run deploy:local
```

## Stack

| Layer | Technology |
| --- | --- |
| Dashboard | Next.js App Router through vinext, React, shadcn/ui, Tailwind CSS |
| Backend and MCP | Cloudflare Workers, Hono, MCP SDK |
| Metadata | Cloudflare D1 |
| Email and attachments | Private Cloudflare R2 |
| Receiving and sending | Cloudflare Email Routing / Email Sending |
| Dashboard authentication | Cloudflare Access |
| MCP authentication | Cloudflare Workers OAuth provider, KV, and D1 connection controls |

## Current limits

- Outgoing email: 5 MiB including attachment encoding; up to 50 combined recipients. Dashboard uploads: 3 MiB per attachment. Incoming email: 25 MiB. MCP attachment downloads: 2 MiB.
- **Sent to Cloudflare** means the sending provider accepted the message. It does not confirm recipient delivery or inbox placement. Ambiguous failures stay uncertain and are not automatically retried.
- Search covers subjects, sender names/addresses, recipients, and full message text, including text extracted from HTML. D1 stores the searchable text and FTS5 index; R2 retains original email, HTML and attachments. Counts reflect the complete filtered mailbox across every page. See [search indexing and backfill](docs/search.md). Press `/` or Cmd/Ctrl+K for commands, and Cmd/Ctrl+B to collapse the sidebar.
- Formatted messages are sanitized and displayed in a sandbox with scripts and forms blocked. External images load by default; use the message’s Images on/off control to block them.
- Trash is retained and reversible. External historical mail is not imported automatically.
- Native mail apps use the optional Docker IMAP/SMTP bridge. Create a mailbox password under **Settings → Mail apps**; see [Apple Mail setup and bridge deployment](docs/imap-integration.md).
- You can add the dashboard to an iPhone Home Screen. Push notifications and offline support are not implemented.

See [security and operations](docs/security.md), [deliverability notes](docs/deliverability-investigation.md), and [third-party notices](THIRD_PARTY_NOTICES.md).
