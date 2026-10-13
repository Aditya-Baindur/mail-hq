# Mail HQ architecture

Mail HQ runs its dashboard, HTTP API, MCP server, OAuth provider, and hosted-domain email receiver in one Cloudflare Worker. D1 stores mailbox state and the search index; private R2 stores message bodies, MIME, and attachments. An optional Go gateway adds IMAP and SMTP, while personal domains use small relay Workers in their owners' Cloudflare accounts.

This document describes the implementation in this repository. Hostnames below use `APP_ORIGIN` and `MCP_HOST` from the deployment configuration; installation-specific identifiers and credentials do not belong in this document.

## System overview

```mermaid
flowchart TB
    Browser["Dashboard browser"]
    Access["Cloudflare Access"]
    Agents["MCP clients"]
    MailApps["Native mail apps"]
    Bridge["Optional Go IMAP / SMTP bridge"]
    HostedRouting["Hosted-domain Email Routing"]
    PersonalRouting["Personal-domain Email Routing"]
    Relay["Relay Worker in domain owner's account"]

    subgraph Runtime["Mail HQ Worker"]
        Entry["entry.ts / index.ts: request dispatch"]
        UI["vinext dashboard + static assets"]
        API["Hono dashboard API"]
        MCP["OAuth provider + MCP tools"]
        Mail["Mail, search, domain and bridge services"]
        Entry --> UI
        Entry --> API
        Entry --> MCP
        Entry --> Mail
        API --> Mail
        MCP --> Mail
    end

    Browser --> Access --> Entry
    Agents -->|"Streamable HTTP + bearer token"| Entry
    MailApps -->|"IMAP / SMTP over TLS"| Bridge
    Bridge -->|"HTTPS + bridge secret + app password"| Entry
    HostedRouting -->|"email event"| Mail
    PersonalRouting --> Relay
    Relay -->|"HMAC-signed HTTPS delivery"| Entry
    Mail --> D1[("D1: metadata, ownership, search")]
    Mail --> R2[("Private R2: mail objects")]
    MCP --> KV[("Private KV: OAuth provider state")]
    MCP --> D1
    Mail --> Sending["Cloudflare Email Sending"]
    Mail --> Control["Cloudflare APIs: domain and routing setup"]
```

The dashboard and machine endpoints share a deployment but use different hostnames and authentication. Email is stored centrally even when a personal domain's routing and sending infrastructure belongs to another Cloudflare account. The Go bridge translates protocols and keeps connection state; D1 and R2 remain the persistent mailbox store.

## Request routing and authentication

[`worker/src/entry.ts`](../worker/src/entry.ts) calls `fetchApi()` in [`index.ts`](../worker/src/index.ts) before serving the frontend. If no API route handles a request, the entry point verifies the dashboard session, then serves either protected static assets or the vinext app. Its `email` handler calls `receiveEmail()` directly.

| Surface | Entry point | Authentication and scope |
| --- | --- | --- |
| Dashboard pages, static assets, `/api/*` | `APP_ORIGIN` | Cloudflare Access application JWT; API resources restricted to the signed-in user's mailboxes |
| OAuth consent | `APP_ORIGIN/oauth/authorize` | Access JWT, same-origin form submission, single-use consent bound to the verified session |
| OAuth discovery, registration, token exchange | `MCP_HOST/.well-known/*`, `/oauth/register`, `/oauth/token` | Public protocol endpoints; provider validates client registration, PKCE, grants, and token requests |
| MCP | `MCP_HOST/mcp` | OAuth bearer token or manual `mhq_` token; exactly one mailbox and independent read/write/admin permissions |
| Mail-app bridge API | `MCP_HOST/bridge/v1` | Shared bridge secret plus a revocable password for one mailbox |
| Personal-domain delivery | `MCP_HOST/inbound/:domainId` | HMAC signature covering timestamp, envelope addresses, and body digest; recipient must belong to that domain |
| Legacy dashboard hosts | `REDIRECT_HOSTS` | Redirect to `APP_ORIGIN` before normal routing |

[`auth.ts`](../worker/src/auth.ts) validates the Access JWT signature, issuer, audience, expiry, and user identity. [`accounts.ts`](../worker/src/accounts.ts) derives the user ID from the verified, normalized email. `OWNER_EMAIL` identifies the infrastructure administrator and the account allowed to claim legacy unowned resources. Administrator status does not grant access to other users' mail.

`scope()` in [`model.ts`](../worker/src/model.ts) checks mailbox ownership or the connection's assigned mailbox and permission. Direct-ID operations, such as message and attachment reads, still pass through these checks. Dashboard mutations also require the expected origin. Local development bypasses Access only when `LOCAL_DEV=true` and the request uses `localhost` or `127.0.0.1`.

## Source map

| Area | Main files | Responsibility |
| --- | --- | --- |
| Frontend shell | [`app/`](../app/), [`components/dashboard.tsx`](../components/dashboard.tsx) | Workspace navigation, mailbox selection, message lists, polling, and commands |
| Compose and read | [`composer.tsx`](../components/composer.tsx), [`message-reader.tsx`](../components/message-reader.tsx), [`search-highlight.tsx`](../components/search-highlight.tsx) | Draft saves, attachments, sanitized HTML display, and highlighting |
| HTTP application | [`entry.ts`](../worker/src/entry.ts), [`index.ts`](../worker/src/index.ts) | Host dispatch, dashboard REST routes, validation, and error responses |
| Identity and authorization | [`auth.ts`](../worker/src/auth.ts), [`accounts.ts`](../worker/src/accounts.ts), [`model.ts`](../worker/src/model.ts) | Principals, ownership, permission checks, audit events, and rate limits |
| Mail and search | [`mail.ts`](../worker/src/mail.ts), [`search.ts`](../worker/src/search.ts), [`mime.ts`](../worker/src/mime.ts) | Receive, send, list, read, MIME handling, and searchable text |
| MCP and OAuth | [`mcp.ts`](../worker/src/mcp.ts), [`oauth.ts`](../worker/src/oauth.ts) | Tool registration, OAuth consent, and mailbox connections |
| Domain management | [`cloudflare.ts`](../worker/src/cloudflare.ts), [`domains.ts`](../worker/src/domains.ts), [`dns.ts`](../worker/src/dns.ts), [`personal-domains.ts`](../worker/src/personal-domains.ts) | Provisioning, domain readiness, routing rules, and personal-account relays |
| Credentials and deletion | [`settings.ts`](../worker/src/settings.ts), [`mailboxes.ts`](../worker/src/mailboxes.ts), [`storage.ts`](../worker/src/storage.ts) | Encrypted configuration, resumable mailbox deletion, and cleanup of writes to inactive mailboxes |
| Native mail | [`bridge/main.go`](../bridge/main.go), [`worker/src/bridge.ts`](../worker/src/bridge.ts), [`mail-profile.ts`](../worker/src/mail-profile.ts) | IMAP/SMTP gateway, persistent UID mapping, submission, and Apple Mail profiles |
| Schema and verification | [`migrations/`](../migrations/), [`tests/`](../tests/), [`bridge/main_test.go`](../bridge/main_test.go) | Ordered schema changes and application/protocol tests |

The browser calls the JSON API through [`components/shared.tsx`](../components/shared.tsx). Bootstrap and visible message lists refresh on a 30-second interval; search input is debounced. Drafts are saved through the API into D1. There is no separate realtime service, browser offline mail store, or push-notification service.

## Storage and data ownership

```mermaid
erDiagram
    users o|--o{ domains : owns
    users o|--o{ mailboxes : owns
    domains ||--o{ mailboxes : contains
    domains ||--o| domain_connections : connects
    domains ||--o{ protected_addresses : protects
    mailboxes ||--o{ messages : stores
    mailboxes ||--o{ drafts : stores
    mailboxes ||--o{ attachments : owns
    messages o|--o{ attachments : includes
    mailboxes ||--o{ agent_tokens : authorizes
    mailboxes ||--o{ oauth_connections : authorizes
    mailboxes ||--o{ mail_app_passwords : authorizes
    mailboxes ||--o{ imap_entries : maps
    messages ||--o{ message_search_chunks : indexes
    messages ||--o| message_search_state : tracks
```

This diagram shows the main D1 relationships, not every table or column. Ownership is nullable for legacy rows until the configured owner claims them. Attachments can exist before they are assigned to a message. `thread_id` groups messages within a mailbox; there is no separate threads table. OAuth connection `user_id` values are hashes of user identities, not foreign keys to `users.id`.

| Store | Contents | Important properties |
| --- | --- | --- |
| D1 `DB` | Users, domains, mailbox/message metadata, drafts, attachment references, credential hashes, OAuth connection controls, IMAP state, search text/index, audit events, rate limits | Authoritative ownership and connection revocation checks; prepared statements and transactional batches |
| R2 `MAIL_STORE` | Body JSON, original incoming/client MIME, attachments, IMAP MIME snapshots, encrypted shared provisioning token | Private objects referenced by keys in D1; body reads and attachment downloads require authorization |
| KV `OAUTH_KV` | OAuth provider client registrations, grants, and token records | Provider-managed protocol state; D1 separately enforces current mailbox ownership, status, expiry, and revocation |
| Worker secrets | Configuration encryption key and optional bridge/API credentials | Supplied by the deployment environment; secret values are not part of source or frontend assets |

`domain_connections.credentials` holds personal-domain API tokens and relay secrets encrypted with AES-GCM and the domain ID as authenticated context. The shared provisioning token is encrypted in R2. Manual MCP tokens and mail-app passwords are stored as hashes in D1. `CONFIG_ENCRYPTION_KEY` must remain stable to decrypt existing configuration.

D1 and R2 writes do not form a distributed transaction. Mail paths write objects and then commit metadata/search batches, with targeted cleanup on failure. Retain D1 and R2 together in backups; restoring only one can leave missing bodies or orphan objects. The search index is derived and can be rebuilt from retained metadata and bodies.

## Receiving and sending email

### Receive path

```mermaid
sequenceDiagram
    participant Routing as Cloudflare Email Routing
    participant Relay as Personal-domain relay
    participant Worker as Mail HQ receiver
    participant R2 as Private R2
    participant D1 as D1

    alt Hosted domain in the installation account
        Routing->>Worker: email event with envelope and MIME
    else Personal domain in another account
        Routing->>Relay: email event
        Relay->>Worker: POST /inbound/:domainId with signed MIME
        Worker->>Worker: Verify signature, freshness, domain and recipient
    end
    Worker->>D1: Find active recipient mailbox and check duplicate
    Worker->>Worker: Parse MIME and resolve mailbox-local thread
    Worker->>R2: Store original MIME, body JSON and attachments
    Worker->>D1: Batch message, attachments and search-text writes
    D1->>D1: Triggers synchronize FTS index and IMAP entries
    alt Hosted domain
        Worker-->>Routing: Finish email handler
    else Personal domain
        Worker-->>Relay: HTTP delivery result
        Relay-->>Routing: Finish or reject email event
    end
```

[`receiveEmail()`](../worker/src/mail.ts) rejects unavailable recipients and messages above the application's 25 MiB limit. A mailbox ID plus raw-message digest produces a deterministic message ID for duplicate suppression. Reply headers are resolved only against messages in that mailbox. Personal-domain relays call the same receive path after signature verification; their HTTP result is returned to the relay, which completes or rejects its email event.

### Send path and failure states

Dashboard `/api/send` and MCP `send_mail`/`reply_to_mail` call `sendMail()`. It validates scope, mailbox/domain readiness, recipients, and attachments, then uses `(mailbox_id, idempotencyKey)` to prevent duplicate submissions. It writes the body to R2 and commits a `sending` message plus search text in D1 before contacting the provider.

```mermaid
stateDiagram-v2
    [*] --> sending: Persist message and search text
    sending --> accepted: Provider accepts and local completion succeeds
    sending --> failed: Failure before submission or definitive rejection
    sending --> uncertain: Submission or local completion outcome is ambiguous
    accepted --> [*]
    failed --> [*]
    uncertain --> [*]
```

`accepted` means accepted by the sending provider, not confirmed recipient delivery. Retrying with the same idempotency key returns the existing message state; an uncertain attempt is not automatically sent again. There is no background send queue or retry worker. SMTP submission has its own MIME persistence and deduplication path in [`worker/src/bridge.ts`](../worker/src/bridge.ts), and shares `sendDomainEmail()` for provider submission.

`sendDomainEmail()` uses the installation's `EMAIL` binding for hosted domains. For a personal domain, it decrypts that domain's credentials and calls Email Sending in the domain owner's account. Provisioning also selects credentials per domain. Connecting a personal domain installs a relay only after validating prerequisites; it does not replace existing MX records or unrelated routing rules.

## MCP and OAuth

The MCP server uses Streamable HTTP with JSON responses and no server-generated session ID. Each request constructs its permitted tool set from the authenticated principal. Dashboard Access sessions, OAuth grants, manual MCP tokens, and native mail passwords are separate credentials.

```mermaid
sequenceDiagram
    participant Client as MCP client
    participant Browser as User browser
    participant Consent as Dashboard consent handler
    participant MCP as MCP host and OAuth provider
    participant KV as OAuth KV
    participant D1 as D1

    Client->>MCP: Discover resource and authorization metadata
    Client->>MCP: Resolve client metadata or register client
    Client->>Browser: Open authorization URL with PKCE challenge
    Browser->>Consent: Sign in through Access and load consent
    Consent->>D1: Record session-bound, single-use consent
    Browser->>Consent: Approve one owned mailbox and permissions
    Consent->>D1: Claim consent and create mailbox connection
    Consent->>KV: Provider records authorization grant
    Consent-->>Browser: Confirmation page navigates to callback
    Browser-->>Client: Authorization code
    Client->>MCP: Exchange code with PKCE verifier
    MCP->>D1: Validate current connection
    MCP->>KV: Provider records tokens
    MCP-->>Client: Access and rotating refresh tokens
    Client->>MCP: Authenticated tools/list or tools/call
    MCP->>D1: Check connection, ownership, mailbox status and scopes
    MCP-->>Client: Allowed tools or mailbox-scoped result
```

The consent handler and OAuth provider in this diagram are logical components of the same Worker. Access tokens last one hour; the connection lifetime is 30 days. Refresh and tool requests consult D1 so a revoked connection, inactive mailbox, expired connection, or changed ownership blocks access independently of provider token storage. Consent records expire after ten minutes and are atomically claimed once.

| Permission | Tools |
| --- | --- |
| Any approved connection | `get_mailbox` |
| Read | `list_mail`, `search_mail`, `read_mail`, `read_attachment`, `get_ai_filter_results` |
| Write | `send_mail`, `reply_to_mail` |
| Admin | Saved-filter CRUD and `update_mailbox_settings` |
| Read + Admin | `run_ai_filter` |

Read tools cannot select another mailbox. Send tools derive the sender from their assigned mailbox and require explicit user authorization. Received email and attachments are untrusted data, including text that resembles instructions. See [MCP setup and OAuth operation](mcp-oauth.md) for client configuration and protocol details.

## Shared email search

`search_mail` exposes the same `listMessages()` and `messageSearchFilter()` path used by the dashboard API. `list_mail` retains its optional `query` parameter. The dedicated tool requires a nonblank query, searches all folders by default, and accepts `folder`, `unread`, `limit`, and `cursor` filters within the connected mailbox.

```mermaid
flowchart LR
    Ingest["Receive, send, or IMAP append"] --> Normalize["Extract and normalize body text"]
    Backfill["Existing-mail backfill"] --> Normalize
    Normalize --> Chunks[("message_search_chunks")]
    Metadata["Message metadata triggers"] --> Chunks
    Chunks -->|"SQL triggers"| FTS[("FTS5 trigram index")]

    Dashboard["Dashboard: GET /api/messages?q=..."] --> List["listMessages + authorization"]
    Tools["MCP: search_mail / list_mail"] --> List
    List --> Filter["messageSearchFilter"]
    Filter -->|"3 or more Unicode characters"| FTS
    Filter -->|"1 or 2 characters: escaped LIKE"| Chunks
    List --> Results["Summaries, total, nextCursor"]
    Results --> Read["Read selected message"]
    Read --> Objects[("R2 body and attachments")]
```

Search covers subjects, sender names/addresses, recipients, previews, and full plain/HTML message text. HTML extraction removes scripts and styles and does not fetch remote resources. Long bodies use overlapping chunks so matches can cross chunk boundaries. Attachment contents and unsent drafts are not indexed by this path.

Queries are literal substrings up to 200 characters; `OR`, quotes, `%`, and `_` are not query operators. Results are ordered by creation time and ID, with cursor pagination and a total count independent of the current page. Search queries read D1 rather than fetching message bodies from R2. Full message reads retrieve R2 content separately.

Dashboard search spans the signed-in user's mailboxes and all folders, temporarily ignoring selected view filters. MCP search always stays within its approved mailbox. [`scripts/backfill-search.mjs`](../scripts/backfill-search.mjs) indexes historical bodies and checks completeness; see [search indexing and backfill](search.md).

## Natural-language AI filters

[`app/ai/page.tsx`](../app/ai/page.tsx) renders [`ai-workspace.tsx`](../components/ai-workspace.tsx), separate from the normal mailbox at `/`. Both share the Access-protected origin. [`ai-filters.ts`](../worker/src/ai-filters.ts) implements the service used by `/api/ai/filters` and MCP. Each saved filter belongs to one mailbox and contains a name, natural-language criteria, folder, probability threshold and version.

```mermaid
flowchart LR
    UI["Separate /ai workspace"] --> API["Access-protected AI API"]
    Agent["MCP agent"] --> Permissions{"Approved scopes"}
    Permissions -->|Admin| Config["Manage filters and display settings"]
    Permissions -->|Read + Admin| Run["Run next scan batch"]
    Permissions -->|Read| Results["Read saved matches"]
    API --> Config
    API --> Run
    API --> Results
    Config --> Filters[("D1: ai_filters")]
    Filters --> Run
    Run --> Pending["Select up to 4 unchecked messages"]
    R2[("R2: body JSON")] --> Text["Extract text; cap at 24,000 characters"]
    Pending --> Text
    Text --> Clef["AI binding: Cloudflare Clef"]
    Clef --> Validate["Validate probability and filter version"]
    Validate --> Cache[("D1: ai_filter_results")]
    Cache --> Results
    Results --> UI
    Results --> Agent
```

Clef answers a typed `noul` question about whether each email satisfies the criteria. The server passes email content as untrusted evidence, validates the returned probability, and never asks the model to execute tools or SQL. See the [Clef model contract](https://developers.cloudflare.com/workers-ai/models/clef/). Folder selection and ownership are enforced before inference. `all` excludes spam and trash. HTML is converted to plain text; attachments are excluded. Oversized bodies are truncated and counted in scan statistics.

```mermaid
erDiagram
    mailboxes ||--o{ ai_filters : configures
    ai_filters ||--o{ ai_filter_results : caches
    messages ||--o{ ai_filter_results : classified
    ai_filters {
        text id PK
        text mailbox_id FK
        text instructions
        real threshold
        integer version
    }
    ai_filter_results {
        text filter_id PK,FK
        text message_id PK,FK
        integer version
        text body_key
        real probability
        integer truncated
    }
```

Migration [`0008_ai_filters.sql`](../migrations/0008_ai_filters.sql) adds these tables with cascading deletion. Cache entries match the filter version and message body key. Editing a filter increments its version; optimistic version checks reject stale edits, and conditional writes prevent in-flight scans from restoring old results or writing into a deleted/inactive mailbox. Cache reuse avoids reclassifying unchanged messages. The current folder membership, checked/pending totals and match counts are computed independently of result pagination.

## Billing and cost visibility

[`billing.ts`](../worker/src/billing.ts) and [`0009_billing.sql`](../migrations/0009_billing.sql) record each Clef inference independently of the result cache. Before calling AI, the server inserts an attempt with the mailbox’s current owner. Afterward, it records returned tokens and an integer cost in billionths of a USD at the current rate ($0.24 per million input tokens). Cached results skip this path. Invalid decisions still retain returned usage; provider failures, missing usage, and interrupted calls remain explicitly unpriced. All calls in a batch settle before reporting a batch failure, so sibling calls can finish recording usage. Retries create new attempts.

```mermaid
flowchart LR
    Run["UI or MCP: run AI filter"] --> Cache{"Cached decision?"}
    Cache -->|Yes| Results["Existing matches"]
    Cache -->|No| Start["D1: record owned inference attempt"]
    Start --> Clef["Workers AI: Clef"]
    Clef --> Usage["Record tokens, status and price snapshot"]
    Usage --> Stats["Statistics: monthly AI estimate"]
    Expenses["Manual monthly expenses"] --> Stats
    Owner["App owner only"] --> API["Cloudflare read-only cost API"]
    API --> Account["Separate account-wide service charges"]
    API --> Unknown["Unavailable or empty: unknown costs"]
```

There are deliberately no cascading foreign keys from `ai_usage` to filters, mailboxes, or messages: deleting content must not erase incurred costs. Ownership is captured before inference and is never reconstructed from a deleted mailbox. UTC calendar-month queries use inclusive start / exclusive end bounds and indexed owner/date lookups. `billing_expenses` stores owner-scoped manual USD entries as integer cents. Dashboard authentication and origin checks protect all billing routes; mailbox MCP permissions, including Admin, do not grant billing or infrastructure access.

The displayed app estimate sums recorded AI list-price cost and manual expenses. It is not an invoice. Cloudflare’s shared daily AI allowance, other workloads, subscription cycles, taxes, and credits affect what is actually billed. Historical requests before the migration are not estimated from cached results or current message counts. The UI displays the tracking start and missing-usage count.

The infrastructure owner’s separate panel calls [`POST /accounts/{account_id}/billable/usage`](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get/) with `Metric: cost` and a maximum 31-day charge period. This POST is a **read-only query** requiring Billing Read and eligibility for Cloudflare’s restricted cost API. A dedicated token can be validated and encrypted using the existing configuration key in private R2 (`system/billing-token`); otherwise the existing provisioning credential is tried. Tokens are never returned to the browser. Each query has a timeout and rate limit. Cost rows are grouped by service and currency; credits retain their sign and missing prices remain unknown. An empty response can mean unsupported cost data, so it is not interpreted as zero spend.

Cloudflare figures cover the whole hosting account, including other apps and potentially the same AI usage. They are never added automatically to the app estimate. The API reports metered usage and may exclude subscriptions and taxes; Cloudflare’s invoice remains authoritative. Separate monthly manual entries can represent a domain registration or external mail bridge host. Pricing references for Workers, D1, R2, KV, and Email Sending are linked in the UI without manufacturing usage estimates from current storage snapshots.

The page scans batches until no messages remain unchecked or the user stops it. Failed batches remain pending and retry safely. Scanning is explicit: no timer, receive hook or scheduled worker calls AI automatically. New mail is picked up on the next run. Scans do not mark mail read, move it, or send messages. Probability thresholds range from 0.5 to 0.99, defaulting to 0.8. Rate limits bound each mailbox to 120 batch requests per minute, and a mailbox can have up to 50 saved filters. Model accuracy is not guaranteed.

READ, WRITE and ADMIN are independent MCP permissions. ADMIN manages only the connected mailbox's app features; it is separate from `Principal.isAdmin`, the infrastructure-owner flag. The dashboard has all three permissions within the signed-in user's own resources. New OAuth grants use `mail:read`, `mail:write`, and `mail:admin`; legacy `mail:send` and manual `send` remain Write aliases without acquiring Admin. Creating, editing and deleting filters or changing display settings requires Admin; running a filter additionally requires Read. Viewing results requires Read. Existing connections must explicitly reconnect or be replaced to gain Admin.

## Native mail, deletion, and operational boundaries

The optional [`bridge/`](../bridge/) container accepts IMAP on TLS port 993 and SMTP submission on TLS port 465, with a configurable port 443 fallback. These are direct mail-protocol connections. Its local HTTP health endpoint can be exposed through a tunnel independently. Each bridge API call carries both the bridge secret and mailbox app password; the Worker rechecks revocation and active mailbox status.

D1 `imap_entries` provides persistent UIDs and folder/flag mappings for messages and drafts. SQL triggers synchronize normal dashboard/mail changes into that mapping. The bridge fetches MIME from the Worker, which reads or builds it from R2/D1. Native IMAP SEARCH has its own protocol implementation in Go; it is separate from the dashboard/MCP FTS query path. See [bridge architecture and deployment details](imap-integration.md).

Mailbox deletion in [`mailboxes.ts`](../worker/src/mailboxes.ts) pauses access, removes only the matching routing rule when required, records a cleanup marker, deletes mailbox objects in bounded batches, then removes database records and records an audit event. The marker allows retries after interrupted cleanup; database guards and write cleanup prevent in-flight work from repopulating a deleting mailbox. Moving a message to Trash is separate and reversible. There is no automatic Trash purge or general orphan-object cleanup job.

Formatted email is sanitized with DOMPurify and rendered in a sandboxed frame. External images have a per-message toggle. Application data responses use private/no-store policies, and the Worker configuration enables logs, traces, and query-string redaction. See [security and operations](security.md) for the complete operational constraints.

## Build, deployment, and verification

```mermaid
flowchart LR
    Source["App, components and Worker TypeScript"] --> Vite["Vite + vinext + Cloudflare plugin"]
    Config["Selected Wrangler source config"] --> Vite
    Vite --> Server["dist/server: Worker, SSR and generated config"]
    Vite --> Client["dist/client: static assets"]
    Migrations["migrations/*.sql"] --> Apply["Apply pending D1 migrations"]
    Server --> Deploy["Wrangler deploy"]
    Client --> Deploy
    Apply --> Deploy
    Deploy --> Production["One Worker with dashboard and MCP domains"]
```

[`vite.config.ts`](../vite.config.ts) uses `wrangler.jsonc` by default. `npm run build:production` selects the installation's ignored `wrangler.production.jsonc` via `MAIL_HQ_CONFIG`. Deployment uses the generated `dist/server/wrangler.json`; selecting a different source config after the build does not rebuild that output. The package deployment scripts apply D1 migrations before uploading the Worker and assets. The optional Go bridge is built and deployed separately with Docker Compose.

[`scripts/package-mcp-deploy.mjs`](../scripts/package-mcp-deploy.mjs) is an alternative packager for restricted API-upload environments. It embeds assets behind the same Access check and produces a local upload bundle; it does not itself publish a deployment.

GitHub Actions runs dependency installation, TypeScript checking, Vitest, and the application build on pull requests and pushes to `main`; it does not deploy production. Tests use isolated SQLite-backed D1 fixtures, in-memory R2/KV, signed Access JWT fixtures, and mocked sending/control-plane APIs. OAuth tests also exercise the official MCP SDK client. Go tests cover native protocol behavior separately.

Use `npm run typecheck`, `npm test`, and the intended build for application changes. Use `go test -race ./...` inside `bridge/` for bridge changes. Deployment verification should check the active Worker version, OAuth discovery, protected routes, and an authenticated MCP request. Local test success does not establish recipient delivery or device-specific mail-client behavior. Worker code rollback does not restore D1/R2 data.

See [deployment](deployment.md), [accounts and personal domains](accounts.md), [MCP/OAuth](mcp-oauth.md), [search](search.md), and [native mail](imap-integration.md) for setup and maintenance procedures.
