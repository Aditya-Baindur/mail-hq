# Agent Vault Chrome extension

This branch distributes the extension for the deployed Mail HQ Agent Vault.
The ZIP contains only the six runtime files; it contains no vault credentials or configuration secrets.

## Install

1. Download `agent-vault-extension.zip` and extract it to a persistent folder on the computer where your agent runs its browser.
2. In that browser, open `chrome://extensions`, enable Developer mode, choose Load unpacked, and select the extracted folder.
3. Open the extension and set the server origin to `https://vault.mail.byaditya.com`.
4. Choose Pair with Mail HQ. Open the resulting approval URL on your own computer, compare the fingerprint, and approve the required websites in Mail HQ.
5. Open an approved website and enable Handle agent fill requests on this website if you want automatic filling.
6. Connect your MCP client separately to `https://vault.mail.byaditya.com/vault/mcp` using OAuth.

For Playwright, use its bundled Chromium with a persistent browser context and load the extension in the same browser context the agent controls. Retain the profile between runs.

## Behavior and boundaries

The MCP tools generate and store credentials, list usernames, and request autofill. They do not return passwords. Autofill supports checked same-origin HTTPS forms and does not submit forms or confirm account creation. Browser DOM or debugging access can read passwords after filling. Only pair browser environments that you trust with the selected accounts.

This is a manually installed extension, not a Chrome Web Store listing. `SHA256SUMS` records the packaged download checksum.
