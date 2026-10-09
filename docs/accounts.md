# Private accounts and personal domains

Mail HQ hosts multiple private accounts on one installation. Cloudflare Access verifies sign-in; the normalized verified email identifies the account. Users can read and manage only their own mailboxes, messages, drafts, attachments, mail-app passwords, agent tokens, and activity. The installation owner has infrastructure controls but does not have dashboard access to other users’ mail. The infrastructure operator still controls the underlying database and storage.

## Upgrade an existing installation

1. Set the Worker variable `OWNER_EMAIL` to the email shown in your current Mail HQ Settings. Keep the existing encryption key, D1, R2, and KV bindings.
2. Build and deploy with the normal migration-first deploy command. Migration `0007_accounts.sql` adds ownership and encrypted domain connections without deleting mail.
3. Sign in as the owner before inviting users. Existing unassigned domains and mailboxes are attached to `OWNER_EMAIL`, including their existing mail and credentials. Ownership is never given to the first visitor. Without this variable, legacy mail remains inaccessible in the dashboard.
4. Add each user’s email to the Allow policy of the existing Cloudflare Access dashboard application. Send them the app URL. Their account is created on first sign-in.
5. Keep the MCP hostname outside the dashboard’s Access application. `/inbound/:zoneId` on that hostname authenticates signed relay requests; it must reach the Worker without an interactive login. OAuth and the optional mail bridge also use this hostname.

`LOCAL_DEV=true` on localhost uses the separate `local-development` account and treats it as the local owner. Never enable that variable in production. Do not change `OWNER_EMAIL` to transfer existing mail: already assigned mail stays with its original account. Changing a sign-in email requires an explicit ownership migration.

## Connect a user’s own domain

The domain stays in the user’s Cloudflare account. In that account:

1. Activate the zone and enable Email Routing. If another provider handles mail, plan the MX migration separately; Mail HQ does not change MX or replace existing address rules.
2. Enable Email Sending for the domain and complete Cloudflare’s verification. Sending availability depends on the user’s account. Receiving can be connected before sending is enabled.
3. Create a token restricted to the domain and its account with these permissions:
   - Zone: Zone Read, Zone Settings Read, DNS Read, Email Routing Rules Edit, and Email Sending Read.
   - Account: Workers Scripts Edit and Email Sending Edit.
4. In Mail HQ, open **Settings → Connect your domain**, enter the Zone ID from Cloudflare’s domain Overview and the token, then choose **Connect domain**.
5. Create a mailbox. Mail HQ adds an exact-address rule to a dedicated `mailhq-…` relay Worker in that account. Conflicting existing addresses remain protected.

The token proves access to the zone. Account ID and domain name are read from Cloudflare, never trusted from browser input. Connecting reserves the domain for the signed-in account, installs a dedicated relay, and saves encrypted credentials. Setup can be retried with **Reconnect**; it reuses the same relay and signing key. Reconnect also refreshes receiving/sending readiness and replaces an expired token. A domain cannot be claimed by another user even if its initial setup was interrupted.

## Delivery and credential handling

Inbound relay requests sign the envelope sender, recipient, timestamp, and raw MIME digest with HMAC-SHA256. The hosted app checks the signature, a five-minute timestamp window, and that the recipient belongs to the connected domain. Identical MIME retries are deduplicated per mailbox. The relay rejects unavailable mailboxes; temporary delivery failures throw rather than silently accepting lost mail.

Personal-domain sending uses the connected account’s Cloudflare REST API. Dashboard, MCP, and SMTP submissions all select credentials by mailbox domain. Attachments are base64 encoded and REST field names are translated explicitly. Mail HQ preserves the provider’s `message_id` when returned; older REST responses omit it, and Mail HQ never invents one for threading. A partial bounce or ambiguous request failure is marked uncertain and never automatically resent. Host-account domains continue using the existing email binding.

Tokens and relay signing secrets are encrypted with AES-GCM using `CONFIG_ENCRYPTION_KEY`, with the domain ID authenticated alongside the ciphertext. Secrets are never included in bootstrap responses or generated mail-app profiles. Back up the key together with D1 and R2. Rotating it without re-encrypting the saved configuration will break connections.

Deleting a personal-domain mailbox removes only its exact rule from that user’s account. It checks that the rule still points to the expected relay before removing anything. The domain connection and relay remain available for other mailboxes. To retire a connection, delete its mailboxes first, then revoke its API token and remove its relay in Cloudflare. Domain transfer and self-service account deletion are not implemented.

## Validation and deployment limits

Automated tests cover two-user data isolation, direct resource-ID attacks, legacy ownership, OAuth consent, domain control, failed setup retries, encrypted credentials, signed inbound delivery, and REST request conversion. They mock Cloudflare control-plane and sending APIs; run a real receive/send check on a domain you control after deployment. Do not interpret a successful mock test as live provider acceptance.

API references: [JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Worker upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/), [Email Sending REST](https://developers.cloudflare.com/api/resources/email_sending/methods/send/), and [recipient schemas](https://developers.cloudflare.com/email-service/examples/email-sending/recipients/).
