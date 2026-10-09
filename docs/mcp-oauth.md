# Connect Mail HQ with OAuth

Use `https://mcp.mail.example.com/mcp`, replacing the hostname with your installation's MCP host. The deployed byaditya installation uses **https://mcp.mail.byaditya.com/mcp**. Copy the exact URL from **Mail HQ → Agents**.

Start the connection in your MCP client. The browser opens Mail HQ's existing Cloudflare Access sign-in, followed by a consent page. Check the requesting app and callback destination, select the exact mailbox, and choose permissions. Read is selected initially; sending requires selecting **Send and reply from this mailbox**. Each approval connects one mailbox.

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
| `mail:read` | `list_mail`, `read_mail`, `read_attachment` |
| `mail:send` | `send_mail`, `reply_to_mail` |
| `offline_access` | Automatic token refresh within the connection lifetime |

Tokens grant access only to the mailbox approved for that connection. Access tokens last one hour. Refresh tokens rotate, and the Mail HQ connection expires 30 days after approval. Reconnect after expiry. Pause the mailbox or revoke the connection under **Agents** to block further access and token refresh. Approving a second mailbox creates a separate connection without revoking the first.

Existing manual tokens remain available under **Create manual token**. Apple Mail credentials and OAuth connections are separate.

## Operator notes

The existing Worker serves the OAuth provider; no VPS or tunnel changes are needed. Keep the MCP hostname outside interactive Access and the dashboard hostname protected on every path. Discovery advertises `APP_ORIGIN/oauth/authorize`; token exchange, revocation, registration and MCP stay on `MCP_HOST`.

Bind private `OAUTH_KV`, apply migration `0004_mcp_oauth.sql`, and keep `global_fetch_strictly_public` plus query-string redaction enabled. The provider handles authorization codes, token encryption, refresh rotation, registered callbacks, resource binding and client assertions. D1 adds immediate mailbox and connection checks and atomic consent claims. Consent lifetimes are ten minutes and each consent is bound to the exact verified Access session. An absent secondary consent cookie can be recovered only by that original session, with a same-origin form submission and an atomic single-use claim. If your sign-in session changes or an old authorization page expires, restart the connection from your MCP client; no access or refresh tokens are exposed in the UI.

The approval HTML must use `Referrer-Policy: same-origin`: `no-referrer` makes browsers send `Origin: null` on the native Allow/Cancel form POST, which the CSRF check rejects. Callback redirects retain `no-referrer`. Do not accept null or arbitrary origins to work around this error. After updating this header, restart the connection from the MCP client to load a fresh approval page.

Protocol endpoints on the MCP origin:

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`
- `/oauth/register`
- `/oauth/token` (also RFC 7009 revocation)
- `/mcp`

Tests use signed Access JWT fixtures, the real OAuth provider and isolated D1/KV stores. They do not send mail. Complete browser approval in each installed app to verify its account-specific connection.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [Cloudflare OAuth provider](https://github.com/cloudflare/workers-oauth-provider), [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [Cursor MCP](https://cursor.com/docs/context/mcp).
