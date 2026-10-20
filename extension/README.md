# Agent Vault Chrome extension v1.2.6

This branch distributes the extension for the deployed Mail HQ Agent Vault.
The ZIP contains only the runtime files; it contains no vault credentials or configuration secrets.

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

Replace the runtime files in the existing extension folder, then click Reload in `chrome://extensions`. Version 1.2.6 adds `protocol.js`; keep it next to `background.js`. Keep the same folder and browser profile to retain the pairing. Under **Agent Vault → Access → Chrome extensions**, explicitly enable the all-websites option for an existing pairing. Reconnect MCP to approve broader agent permissions; existing grants never expand automatically.

Manage blocked domains under **Agent Vault → Websites → Blocked domains**. A block includes the domain and every subdomain, on all ports, and applies to both specific and broad grants. It prevents future vault use, including queued fills; it cannot log out a browser session that already exists. Saved credentials still fill only on their exact saved origin.

With all-websites create permission, call `vault_create_credential` with `origin` (for example `https://example.com`) instead of `serviceId`. Keep the returned `serviceId` and `accountId` for subsequent fill requests. Creating a credential does not register an account on the website.

## Pending browser approvals

Use the exact Mail HQ email displayed in the dashboard’s Pending browser approvals section. The email routes the request; it does not authenticate the browser or grant access. Requests appear only in that account’s dashboard, which refreshes every 15 seconds. Device names are unverified; compare the fingerprint before approving. The extension reports approval, denial or expiry. Existing approved pairings continue working after upgrading. Older link-only requests do not appear in the inbox; use v1.2.0 to create a new request. MCP OAuth setup is unchanged.

Version 1.2.1 also lets an existing link-only pending request be resent immediately: enter your Mail HQ email and click Request pairing. You do not have to wait for the old request to expire.

## Version 1.2.2: JavaScript forms and field validation

- Supports same-origin JavaScript-managed forms that omit both `action` and `method`, addressing the form pattern reported on Workday (Snap and BDO). Explicit GET methods, cross-origin destinations and unsafe submitter overrides remain blocked. An ordinary native GET submission is cancelled for these forms if the site's JavaScript does not handle it, keeping credentials out of URL parameters.
- Focuses each field, updates its native value, emits input/change, and blurs it. React controlled inputs and validators that commit on blur now recognize the filled value, addressing the validation pattern reported on EA. No synthetic password characters are put in event payloads or exposed through MCP.
- Checks relative submitter destinations against the document's base URL, includes image submit buttons, and rejects unsafe base targets.

Verified with the real unpacked extension in Chromium, local React controlled signup forms, blur validation and a native GET fallback regression. Live EA, Snap and BDO account flows have not been verified. A successful fill does not mean registration or an application succeeded; unusual site validation can still require investigation.

After replacing the files and clicking Reload in `chrome://extensions`, refresh the signup tab and request another **Fill signup**. Keep the same extension folder and browser profile to retain pairing. No server deployment or new permission grant is needed for this update.

## Version 1.2.6: field detection, frames, and pairing errors

- Ignores password fields a person cannot see or type into (hidden, disabled, read-only, zero-size, `hidden`, `aria-hidden`, inert, or a closed dialog).
- Signup may fill a lone `autocomplete=current-password` field when it is the only visible password field. A current-password field next to a new-password field is still left alone.
- Fills password fields that are not inside a `<form>` only when every visible password field is formless, the set is one field (login) or one field or a new/confirm pair (signup or replacement), and the nearest container has exactly one clear action control. The extension does not click or submit. Off-site links are not treated as that action. There is no form destination to check; the page can still read a value after it is filled, which is already true of every fill.
- Fills a same-origin HTTPS iframe only when that frame's ancestors and the top window are the same origin and it is the only frame with visible password fields. Cross-origin frames are never filled. A subframe fill is pinned to the document that was probed.
- After filling, checks that the field kept the value and returns only a count or an error code.
- The popup keeps the last fill's code (never the password). Vault timeouts and 5xx responses show as unreachable and retry; they do not open the pairing form or mint a key. The pairing form appears when nothing is stored, the key is missing, or the vault reports an explicit pending, denied, expired, or revoked pairing. A new key is created only when you click **Request pairing**.

Reload the unpacked extension after replacing these files. Keep the same folder and profile so the pairing stays. No new host permission is required for a same-origin iframe on a tab you already opened. Password rules for a site are a server setting (`passwordPolicy` on create and rotate) and do not depend on this extension.
