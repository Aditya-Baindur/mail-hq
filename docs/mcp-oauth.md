# Connect Mail HQ with OAuth

Use `https://mcp.mail.example.com/mcp`, replacing the hostname with your installation's MCP host. The deployed byaditya installation uses **https://mcp.mail.byaditya.com/mcp**. Copy the exact URL from **Mail HQ → Agents**.

Start the connection in your MCP client. The browser opens Mail HQ's existing Cloudflare Access sign-in, followed by a consent page. Check the requesting app and callback destination, select the exact mailbox, and choose **READ**, **WRITE**, and/or **ADMIN**. Only READ is selected initially. Each approval connects one mailbox.

## Multiple mailboxes with one sign-in

Mail HQ already supports multiple independent OAuth connections from the same client and signed-in user. Each connection has its own mailbox, permissions, access/refresh tokens, expiry, and revocation. Connecting mailbox B leaves the mailbox A connection intact. An existing valid Cloudflare Access browser session can be reused for both approvals; you still approve each mailbox connection separately.

If your MCP client supports multiple separately authenticated connections to the same server:

1. Add `https://mcp.mail.byaditya.com/mcp` as one connection (for example, “Hiring mail”). Approve only the hiring mailbox and its needed permissions.
2. Add a second connection (for example, “Support mail”). Reuse your browser sign-in, then approve the support mailbox.
3. Assign each connection only to the intended bot using the client's access controls. Keep the tokens separate; sharing a token shares that token's mailbox access.
4. Call `get_mailbox` from each connection to verify its assigned address. Manage and revoke each grant independently in **Mail HQ → Agents**.

Client support for separately stored connections is required. Adding two display names is insufficient if a client stores only one token for this server URL. A single shared OAuth grant cannot securely distinguish bots or give them different mailbox permissions. Mail HQ never selects authorization based on a bot name, prompt, email argument, or unsigned caller-supplied agent ID.

### Grok Bot limitation

As of October 13, 2026, [Grok Bot documents that installed connectors are account-wide](https://docs.x.ai/grok-bot/computer-and-apps#connect-an-app). Its bots also share computer files, credentials, and signed-in browser sessions. Consequently, separate Mail HQ grants enforce **one mailbox per connection**, but do not establish **one mailbox per Grok bot** within the same Grok account. Attaching a particular connector to a task is a workflow choice, not an access boundary between bots.

For strict bot isolation, the hosting platform must keep each bot's credentials and connected tools separate, or provide a verified bot identity that a trusted service can map to a mailbox. Separate authenticated host accounts or an isolated custom bot runner can provide that boundary. A Mail HQ server-only change cannot create it for Grok's shared connector model. Do not sign into the full Mail HQ dashboard on a shared bot computer when other bots must not access that browser session.

## ChatGPT

In ChatGPT's custom MCP server setup, enter the MCP URL and select **OAuth**. Leave optional client ID and client secret fields empty: the server supports client ID metadata documents (CIMD) and dynamic client registration (DCR). Start the connection and approve it in Mail HQ. Custom MCP setup may require enabling developer mode for your account/workspace.

If you previously configured this endpoint with a manual token, reconnect it using OAuth. Do not use the Apple Mail app password for MCP.

## Codex

```sh
codex mcp add mail-hq --url https://mcp.mail.byaditya.com/mcp
codex mcp login mail-hq
```

The add command may start login automatically. Finish the browser approval; use the login command when authentication is still needed. For other installations substitute their URL. If updating an existing entry, remove any fixed bearer-token header/environment setting so Codex can use OAuth.

## Cursor

Add the following to your Cursor MCP configuration, merging it with existing servers:

```json
{
  "mcpServers": {
    "mail-hq": {
      "url": "https://mcp.mail.byaditya.com/mcp"
    }
  }
}
```

Use Cursor's MCP sign-in/authentication action and complete the Mail HQ consent screen. OAuth supports Cursor's native callback, HTTPS callbacks and local loopback callbacks.

## Permissions and access management

| Permission | Tools |
| --- | --- |
| Always | `get_mailbox` |
| READ — `mail:read` | `list_mail`, `search_mail`, `read_mail`, `read_attachment`, `get_ai_filter_results` |
| WRITE — `mail:write` | `send_mail`, `reply_to_mail` |
| ADMIN — `mail:admin` | `list_ai_filters`, `create_ai_filter`, `update_ai_filter`, `delete_ai_filter`, `update_mailbox_settings` |
| READ + ADMIN | `run_ai_filter` |
| `offline_access` | Automatic token refresh within the connection lifetime |

Tokens grant access only to the mailbox approved for that connection. Access tokens last one hour. Refresh tokens rotate, and the Mail HQ connection expires 30 days after approval. Reconnect after expiry. Pause the mailbox or revoke the connection under **Agents** to block further access and token refresh. Approving a second mailbox creates a separate connection without revoking the first.

The three permissions are independent. ADMIN configures the connected mailbox's app features; it does not imply READ or WRITE and does not grant infrastructure administration, credential management, or access to other mailboxes. `update_mailbox_settings` changes only its display name and color. Existing `send` manual tokens and `mail:send` OAuth grants remain compatible as WRITE aliases. They never gain ADMIN automatically. Reconnect through OAuth or create a new manual token to grant ADMIN explicitly.

Existing manual tokens remain available under **Create manual token**, with READ, WRITE and ADMIN checkboxes. Apple Mail credentials and OAuth connections are separate.

## Natural-language AI filters

The separate dashboard page **/ai** and MCP use the same saved Clef filters. Create a filter with ADMIN:

```json
{
  "name": "Interview requests",
  "instructions": "Actual invitations to a job interview or recruiter screening call. Exclude interview advice, job listings, newsletters, and rejections.",
  "folder": "inbox",
  "threshold": 0.8
}
```

Call `create_ai_filter` with those arguments. It returns `filter.id` and `filter.version`; the mailbox comes from the connection. With READ + ADMIN, call `run_ai_filter` using `{ "filterId": "<id>", "version": 1 }`. Each call checks up to four previously unchecked messages and consumes Workers AI usage. Repeat until `stats.pending` reaches zero. Call `get_ai_filter_results` to read matches, passing `nextOffset` as `offset` for subsequent pages.

Use `list_ai_filters` to retrieve definitions before editing. `update_ai_filter` requires the current version plus the complete new name, instructions, folder and threshold. Edits invalidate old classifications; a concurrent edit rejects stale writes or scan results. `delete_ai_filter` removes the definition and cached classifications, leaving messages intact.

Scans evaluate semantic intent with `@cf/cloudflare/clef`, default to the inbox, and reuse cached classifications. `all` includes every folder except spam and trash. Other supported scopes are `archive` and `sent`. New messages are evaluated when the user or agent runs the filter again; there is no scheduled background scan. A run never changes read status, moves messages, or sends mail. AI decisions can be wrong. Body text is limited to 24,000 characters per email, truncated messages are counted, and attachment contents are excluded. Results report checked/pending counts so an incomplete scan is visible.

Bind `AI` in Wrangler and apply `0008_ai_filters.sql` before deploying this feature. See the [AI architecture](architecture.md#natural-language-ai-filters) and [Cloudflare Clef API](https://developers.cloudflare.com/workers-ai/models/clef/).

## Search emails

Use `search_mail` with a required, nonblank `query` of up to 200 characters:

```json
{ "query": "invoice 2026", "limit": 20 }
```

Search uses the same index as the dashboard and covers subjects, sender names/addresses, recipients, and full message text, including text extracted from HTML. It matches literal text and partial words; it does not interpret search operators or search attachment contents. Only the connected mailbox is searched, across all folders by default. Optionally set `folder` (`inbox`, `sent`, `archive`, `trash`, `spam`, or `all`) and `unread: true`.

Results contain `messages`, `total`, and `nextCursor`. Pass `nextCursor` as `cursor` with the same query and filters to get the next page. Use `read_mail` with a result's `id` as `messageId` to read the complete email. Existing `list_mail` calls with `query` continue to work.

## Operator notes

The existing Worker serves the OAuth provider; no VPS or tunnel changes are needed. Keep the MCP hostname outside interactive Access and the dashboard hostname protected on every path. Discovery advertises `APP_ORIGIN/oauth/authorize`; token exchange, revocation, registration and MCP stay on `MCP_HOST`.

Bind private `OAUTH_KV`, apply migration `0004_mcp_oauth.sql`, and keep `global_fetch_strictly_public` plus query-string redaction enabled. The provider handles authorization codes, token encryption, refresh rotation, registered callbacks, resource binding and client assertions. D1 adds immediate mailbox and connection checks and atomic consent claims. Consent lifetimes are ten minutes and each consent is bound to the exact verified Access session. An absent secondary consent cookie can be recovered only by that original session, with a same-origin form submission and an atomic single-use claim. If your sign-in session changes or an old authorization page expires, restart the connection from your MCP client; no access or refresh tokens are exposed in the UI.

The approval HTML must use `Referrer-Policy: same-origin`: `no-referrer` makes browsers send `Origin: null` on the native Allow/Cancel form POST, which the CSRF check rejects. The completed form returns a no-store HTML confirmation with a nonce-protected navigation and a manual callback link, both using `no-referrer`. It does not return an HTTP redirect: Chrome can apply the consent page’s `form-action` policy to the client’s entire redirect chain and strand the browser after a successful approval. Do not accept null or arbitrary origins to work around this error. After updating this header, restart the connection from the MCP client to load a fresh approval page.

Protocol endpoints on the MCP origin:

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`
- `/oauth/register`
- `/oauth/token` (also RFC 7009 revocation)
- `/mcp`

Tests use signed Access JWT fixtures, the real OAuth provider and isolated D1/KV stores. They do not send mail. Complete browser approval in each installed app to verify its account-specific connection.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [Cloudflare OAuth provider](https://github.com/cloudflare/workers-oauth-provider), [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [Cursor MCP](https://cursor.com/docs/context/mcp).
