# IMAP integration assessment

Status: proposed, not implemented or deployed. The owner wants to use Apple Mail on a phone. The owner has authorized an external Docker bridge on an existing VPS. Implementation and deployment are still pending.

## Hosting findings

Cloudflare announced incoming TCP via Spectrum and a Workers `connect(socket)` handler on August 3, 2026, as a private beta: [announcement and signup](https://blog.cloudflare.com/grpc-workers/). The installed Workers types already expose this handler. The general [TCP socket documentation](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) still describes inbound connections as unavailable; the beta announcement explains the discrepancy. Type support alone does not establish account access.

The inspected account could not verify Spectrum access through its available API connection. Type support alone does not establish incoming-TCP availability. The external VPS is the selected implementation direction.

Two deployment paths are viable in principle:

1. Cloudflare-only: obtain and verify incoming-TCP beta access and its plan/certificate requirements, then use Spectrum to reach an IMAP implementation in a Worker or Cloudflare Container.
2. External gateway: run a small TLS-enabled IMAP/SMTP gateway on a server with public TCP ingress. It calls a dedicated authenticated Worker API; D1 and R2 remain the canonical mailbox store. The owner has authorized this external hosting exception.

## Proposed client connection

| Setting | Proposed value |
| --- | --- |
| Incoming server | `imap.mail.example.com` |
| Incoming transport | IMAP over TLS, port 993 |
| Outgoing server | `smtp.mail.example.com` |
| Outgoing transport | Authenticated SMTP over TLS, port 465 |
| Username | The full address of one Mail HQ mailbox |
| Password | A revocable, randomly generated password restricted to that mailbox |

These are proposed hostnames, not working settings. DNS availability and TLS certificates must be checked before provisioning.

An SMTP submission gateway would authenticate the same mailbox password and call the existing Cloudflare sending service. This keeps sender authorization and sent-message records consistent with the dashboard. Direct use of [Cloudflare's SMTP service](https://developers.cloudflare.com/email-service/examples/email-sending/smtp/) is also possible, but uses a Cloudflare API credential and bypasses the current Mail HQ send-recording path; it is not a substitute for mailbox-scoped submission and synchronization.

## Required application changes

- Add separate mail-app credentials. Existing agent tokens only have `read` and `send` scopes; do not silently extend read-only MCP credentials to permit mailbox mutation. Store credential hashes, support revocation, and restrict every operation to the authenticated mailbox.
- Add persistent IMAP folder state and stable UIDs/UIDVALIDITY. Message UUIDs and date ordering are not IMAP UIDs. Moves, copies, concurrent dashboard edits, and reconnections must preserve IMAP identity rules.
- Map Inbox, Sent, Drafts, Archive, Junk, and Trash with appropriate special-use attributes. Implement flag synchronization, folder moves, and client append operations. Starred is currently a view, not a separate physical folder.
- Bridge the existing `drafts` table to IMAP Drafts. Its JSON composer state is separate from `messages`; exposing a disconnected second drafts store would not provide real synchronization.
- Serve complete MIME messages and attachments. Incoming mail already has raw MIME in R2; messages sent by the dashboard currently store structured bodies and attachment objects without a raw MIME object. Persist a stable MIME representation for these messages before exposing byte ranges and sizes to clients.
- Treat IMAP APPEND to Sent as storing a copy, never as a request to send. Reconcile the client copy with the SMTP submission record to avoid duplicate Sent messages, while retaining legitimate copies.
- Implement notifications for active IMAP sessions and reconnect recovery. IMAP IDLE support does not itself guarantee instant background notifications in Apple's iPhone Mail app.
- Define expunge behavior explicitly. The current dashboard only offers reversible trash and has no permanent deletion. An IMAP implementation must not silently turn deletion into irreversible removal of existing mail.
- Keep interactive Cloudflare Access on the dashboard. Native mail clients use TLS plus mailbox credentials on separate endpoints; do not remove Access to make IMAP work.

## Release checks

Use a standards-aware protocol implementation and an independent IMAP client to test authentication, cross-mailbox isolation, UID stability, MIME/body ranges, attachment integrity, flag and folder synchronization, Drafts/Sent append, error handling, revocation, and reconnects. Test end to end on Apple Mail before claiming device compatibility. Bound connection counts, failed logins, commands, and message sizes.

Backfill additive IMAP metadata for existing managed mailboxes without changing their addresses or delivery routes. Preserve the existing literal forwarding rules and the external iCloud/Porkbun domains. Only new protocol hostnames should be needed for this integration. Production rollout must retain the existing Worker secret, D1, R2, and email bindings.

## Existing tunnel

A standard Cloudflare Tunnel published TCP hostname transports TCP over WebSockets and needs a client-side connector. Native iPhone Mail cannot connect to that published hostname as if it were a public IMAP port. To reuse the tunnel, use private-network routing and the Cloudflare One device app on the phone; alternatively expose only TLS IMAP/submission ports on the VPS. See [Cloudflare protocol documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/).

The inspected tunnel is healthy, currently serves HTTP applications, and has private-network routing disabled. Existing tunnel routes must be preserved. The connection choice still needs confirmation. This repository does not yet ship an IMAP server or working phone connection settings.
