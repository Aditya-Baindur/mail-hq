# Agent Vault Chrome extension v1.2.0

This branch distributes the extension for the deployed Mail HQ Agent Vault.
The ZIP contains only the six runtime files; it contains no vault credentials or configuration secrets.

## Install

1. Download `agent-vault-extension.zip` and extract it to a persistent folder on the computer where your agent runs its browser.
2. In that browser, open `chrome://extensions`, enable Developer mode, choose Load unpacked, and select the extracted folder.
3. On the Grok computer, open the extension and set the server origin to `https://vault.mail.byaditya.com`. Enter your **Mail HQ sign-in email** and name the browser (for example, **Grok VPS**).
4. Click **Request pairing**. On your main computer, open **Agent Vault → Pending browser approvals**. Click **Review request**, compare the fingerprint, confirm it, and approve either individual websites or **All websites except blocked domains, including future websites**. You can deny unfamiliar requests. No Mail HQ login is needed on the Grok computer, and the extension does not open a dashboard tab. Requests expire in ten minutes; the extension checks for your decision while its popup is open.
5. Open a website and enable **Handle agent fill requests on all unblocked websites** in the extension if you want automatic filling across websites. Accept Chrome’s optional HTTPS host permission prompt. Individual-website automatic filling is also available.
6. Connect your MCP client separately to `https://vault.mail.byaditya.com/vault/mcp` using OAuth. Select the all-websites **create** and **fill** permissions to let the agent save new credentials without adding websites manually.

For Playwright, use its bundled Chromium with a persistent browser context and load the extension in the same browser context the agent controls. Retain the profile between runs.

## Behavior and boundaries

The MCP tools generate and store credentials, list usernames, and request autofill. They do not return passwords. Autofill supports checked same-origin HTTPS forms and does not submit forms or confirm account creation. Browser DOM or debugging access can read passwords after filling. Only pair browser environments that you trust with the selected accounts.

This is a manually installed extension, not a Chrome Web Store listing. `SHA256SUMS` records the packaged download checksum.

## Upgrade and blocklist

Replace the six runtime files in the existing extension folder, then click Reload in `chrome://extensions`. Keep the same folder and browser profile to retain the pairing. Under **Agent Vault → Access → Chrome extensions**, explicitly enable the all-websites option for an existing pairing. Reconnect MCP to approve broader agent permissions; existing grants never expand automatically.

Manage blocked domains under **Agent Vault → Websites → Blocked domains**. A block includes the domain and every subdomain, on all ports, and applies to both specific and broad grants. It prevents future vault use, including queued fills; it cannot log out a browser session that already exists. Saved credentials still fill only on their exact saved origin.

With all-websites create permission, call `vault_create_credential` with `origin` (for example `https://example.com`) instead of `serviceId`. Keep the returned `serviceId` and `accountId` for subsequent fill requests. Creating a credential does not register an account on the website.

## Pending browser approvals

Use the exact Mail HQ email displayed in the dashboard’s Pending browser approvals section. The email routes the request; it does not authenticate the browser or grant access. Requests appear only in that account’s dashboard, which refreshes every 15 seconds. Device names are unverified; compare the fingerprint before approving. The extension reports approval, denial or expiry. Existing approved pairings continue working after upgrading. Older link-only requests do not appear in the inbox; use v1.2.0 to create a new request. MCP OAuth setup is unchanged.
