# Apple Mail and IMAP bridge

Mail HQ includes a Docker IMAP/SMTP gateway in `bridge/`. The Worker API, D1 metadata, and private R2 objects remain the canonical store. No mailbox migration or MX changes are required.

## Connect an iPhone

1. In Mail HQ, open **Settings → Mail apps**.
2. Choose the mailbox, enter a device name, and create an app password. Copy it immediately; only its SHA-256 hash is stored.
3. In Safari on the iPhone, select **Download Apple Mail setup**. Existing connections have the same download link.
4. Allow the download, then open **Settings → Profile Downloaded → Install**. Enter the app password when asked. The profile configures the exact hostnames, ports and SSL settings and uses one password for both servers. See [Apple's profile installation instructions](https://support.apple.com/en-ie/102400).

The downloaded profile contains only one Mail account payload. It contains no password, certificate, device management enrollment or VPN settings. It is unsigned, so iOS can display **Not Signed** during installation. Download it from your authenticated Mail HQ dashboard. Removing it under **Settings → General → VPN & Device Management** removes that configured account from the device.

For manual setup, open **Settings → Apps → Mail → Mail Accounts → Add Account**, enter your email if prompted, then choose **Add Other Account → Mail Account** (or **Other → Add Mail Account** on older versions). Choose **IMAP**. Enter only the hostname shown by Mail HQ in both **Host Name** fields, without a URL prefix or port suffix. Ports belong in separate **Server Port** settings. Both usernames are the full mailbox address, and both passwords are the app password; fill in outgoing credentials even if iOS labels them optional. Use the profile if iOS cannot detect the ports. See [Apple's manual setup instructions](https://support.apple.com/en-gb/102619).

| Setting | Incoming | Outgoing |
| --- | --- | --- |
| Protocol | IMAP | SMTP submission |
| Port | 993 | As shown in Mail HQ: 465 by default, 443 with the fallback below |
| SSL/TLS | On | On |
| Authentication | Password | Password |

Under the account's Advanced settings, map Drafts, Sent, Trash, and Archive to their folders on the server. Set Fetch New Data to the frequency you prefer. Generic IMAP does not provide Apple's background push service. IDLE updates active connections approximately every 15 seconds.

Each password is restricted to one mailbox. Create additional passwords for other devices or mailboxes. Revoke a password in the same Mail apps panel. Subsequent mailbox operations reject it; active IDLE sessions close on their next poll. Dashboard Cloudflare Access and MCP token authentication remain independent.

## What synchronizes

- Inbox, Sent, Drafts, Archive, Junk, and Trash; read state, stars, answered and deleted flags.
- Original MIME for received/client-appended messages; deterministic MIME with attachments for dashboard sent mail and drafts.
- The existing dashboard drafts table is used in both directions. Editing a draft replaces its IMAP UID because its content changed.
- Sending uses authenticated SMTP, validates the envelope and From address, and calls Cloudflare Email Sending. SMTP does not relay directly from the VPS.
- Appending to Sent stores a message without sending. The first client Sent copy matching both Message-ID and decoded content of a recent successful SMTP submission is reconciled; later explicit copies remain separate.
- Persistent, monotonically increasing D1 UIDs survive bridge restarts. Moves allocate new UIDs.
- Expunging a message outside Trash moves it to Trash. Expunging Trash hides its IMAP entry while retaining the dashboard copy. Restore it by moving it out of Trash in Mail HQ. Discarding an IMAP draft removes that draft.

Current limits: fixed system folders (custom folder creation/renaming is unavailable), no CONDSTORE/QRESYNC, 25 MiB APPEND, 5 MiB SMTP submission, and 50 recipients. The gateway recomposes submitted MIME using the sending binding, so cryptographic MIME signatures are not preserved. It retains the original submitted message in Sent. Initial folder synchronization can be slower because content is fetched from R2 through the Worker.

## Deploy

1. Apply `migrations/0003_mail_apps.sql` with the existing D1 migration command and keep the existing D1/R2/EMAIL bindings.
2. Generate a random bridge secret. Set Worker secret `BRIDGE_API_SECRET`, and set `BRIDGE_HOST` to the mail hostname. Deploy the Worker and frontend.
3. Copy the bridge directory onto the VPS, for example `/opt/mail-hq-bridge`. Copy `env.example` to `.env`, use the same secret as the Worker, and set the Worker API URL to `https://<MCP_HOST>/bridge/v1`. Protect `.env` with mode 600.
4. Add a **DNS-only** A record for the mail hostname pointing to the VPS. Allow TCP 993 and 465. Port 80 must be reachable when Certbot performs HTTP-01 validation.
5. Obtain a publicly trusted certificate using Certbot's standalone mode and mount `letsencrypt/` as shown in `compose.yaml`.
6. Run `docker compose up -d --build bridge`. The health listener binds only to `127.0.0.1:18790` on the VPS.
7. Add an HTTPS hostname to the existing Cloudflare tunnel targeting `http://127.0.0.1:18790`; `/healthz` reports process health. Preserve the other tunnel routes. Use a hostname covered by the zone's edge certificate.
8. Install `mailhq-cert-renew.service` and `.timer` into `/etc/systemd/system/`, then `systemctl enable --now mailhq-cert-renew.timer`. Adjust the service's working directory if needed. TLS handshakes reload the certificate, so renewal does not require a restart.

If public TCP 465 is filtered and TCP 443 on the VPS is free and reachable, enable the optional TLS-only SMTP fallback: `ln -s compose.smtp-443.yaml compose.override.yaml`, then `docker compose up -d bridge`. Set Worker variable `BRIDGE_SMTP_PORT` to `443` and deploy. The app and downloaded profile will use 443 for SMTP while the standard 465 listener remains available. This port serves SMTP over TLS, not HTTPS; HTTPS health monitoring continues through the existing tunnel. Cloudflare Email Sending still performs actual email delivery.

A standard public Cloudflare Tunnel TCP route requires a client connector and cannot be used directly by iPhone Mail. The mail ports therefore use direct TLS; the existing tunnel serves HTTPS health monitoring. See [Cloudflare's protocol documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/).

## Operations and verification

```sh
npm run typecheck
npm test
npm run build
cd bridge
go test -race ./...
docker compose ps
docker compose logs --tail=50 bridge
curl http://127.0.0.1:18790/healthz
systemctl list-timers mailhq-cert-renew.timer
docker compose run --rm --service-ports certbot renew --standalone --dry-run --no-random-sleep-on-renew
```

The bridge enforces TLS 1.2+, connection and login-attempt limits, finite HTTP timeouts, bounded MIME uploads, and the existing per-mailbox sending limit. The internal Worker endpoint requires both the bridge secret and the mailbox password. It rechecks active mailbox status and password revocation on every API operation. Neither secret should appear in command arguments or logs.

Keep D1 (including `sqlite_sequence`) and R2 together in backups. Never reset the IMAP sequence or restore older UID data under the same UIDVALIDITY; a rollback of mailbox data requires a new UIDVALIDITY to make clients rebuild their caches. Bridge container restarts do not need a UID reset. MIME snapshots and draft attachments are retained in R2; automated orphan cleanup is not implemented.

Protocol tests cover TLS login, exact MIME bytes and partial fetches, read-only EXAMINE behavior, flags, multiple sessions, MOVE, EXPUNGE, date searches, pipelined IDLE completion and revocation. Worker tests cover mailbox isolation, drafts, UID stability, attachments, sender restrictions, submission idempotency, and Sent reconciliation. Actual device behavior must still be checked on an iPhone; server tests cannot establish Apple Mail UI or background-fetch behavior.
