# Security and operations

Mail HQ serves personal email. Keep the dashboard behind Cloudflare Access and the R2 bucket private. Its Worker validates the Access application JWT and rejects mutations from another origin. Access policies determine dashboard users; there is no second hardcoded email allowlist.

MCP tokens are independent, random, hashed at rest, limited to one mailbox, scoped to read and/or send, expiring, and revocable. Never publish tokens or put them in URL query strings. A read-only agent token does not authorize changing mailbox state.

The optional Cloudflare provisioning credential is AES-GCM encrypted in R2. Keep `CONFIG_ENCRYPTION_KEY` stable and backed up privately. Restrict the token to intended zones and permissions. No normal app endpoint overwrites existing MX or email routing rules.

Inbound HTML runs in a sandboxed frame. Scripts, forms, and external resources are blocked. Received mail is untrusted input, including when returned by MCP to an agent. Review agent permissions before allowing it to send.

Retries of a send must reuse its idempotency key. A network failure after submission can make the outcome uncertain; do not automatically resend. A provider-accepted message may still bounce or be filtered into spam.

Retain database and object-storage backups together. Message metadata refers to bodies and attachments by object key. Rolling back Worker code does not roll back D1 or R2. Trash is reversible; there is no automatic permanent-deletion job.

Keep real email samples, deployment account records, private keys, environment files, generated deployment bundles, and test-recipient logs out of Git. Local operator records belong in ignored `.local/`.
