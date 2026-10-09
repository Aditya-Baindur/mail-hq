# Full-message search

MailHQ searches subjects, sender names/addresses, recipients (including Cc/Bcc), previews, and complete message text in D1. HTML is parsed into readable text, including decoded entities and image alt text; scripts, styles and document-head content are excluded. The parser does not fetch remote resources. Both plain and HTML alternatives are indexed when they differ. Attachments are retained in R2 and their contents are not searched.

The dashboard searches all mailboxes and all message folders, including Sent, Archive, Spam and Trash. Searching temporarily ignores the selected mailbox, folder, unread and starred filters; clearing the search restores that view. Searches from Drafts also find stored messages; unsent drafts are separate. Results include the source mailbox/folder and retain counts and date-based pagination across the full result set, not just the loaded page.

Search is a literal substring: `invoice 2026` finds that phrase, and email fragments and punctuation retain their literal meaning. Quotes, `OR`, `%`, and `_` are not search operators. Queries are limited to 200 characters. The dashboard API accepts `folder=all`; explicit mailbox, unread and starred API filters remain supported. MCP `list_mail` searches all folders by default when given a query, or a specified folder if supplied, while always enforcing its assigned mailbox. Ordinary MCP lists still default to Inbox.

Results highlight matching subjects, senders and preview text. Opening a result carries the query into the reader's **Find in this email** field and highlights matches in the subject, addresses and visible message body. The reader scrolls to the first body match; the arrows, Enter and Shift+Enter move between body matches. Clearing the field removes highlights without changing the search results. Both plain and formatted views support highlights, including phrases split across inline HTML tags. The counter refers to the displayed body version; a search can also match headers, image alt text or the other multipart alternative. Highlighting operates on text nodes after HTML sanitization and preserves iframe sandbox/CSP protections.

D1 FTS5 uses its case-insensitive trigram tokenizer for queries of three or more Unicode characters. One- and two-character searches use an escaped substring scan of D1's search text with SQLite LIKE case matching; they do not fetch email bodies from R2. Results remain ordered by date. Text is stored in a separate table, so ordinary inbox lists never load bodies. Long messages use overlapping chunks below D1's row limit, preserving matches across chunk boundaries.

Original `.eml`, HTML, attachments and the existing body JSON remain in R2. D1 holds a derived search copy; nothing is removed from the original storage. Opening a message and native IMAP fetch/search behavior remain unchanged. Messages received, sent through the UI/MCP, or saved/submitted through the mail bridge are indexed transactionally with their database records. Metadata changes and deletion update FTS through database triggers.

## Existing installations

Apply migration `0005_message_search.sql`, deploy the new Worker, and backfill existing bodies:

```sh
npm run search:backfill -- --config wrangler.production.jsonc --remote
```

For another installation, select its Wrangler config with explicit account ID, D1 ID and R2 bucket. The script uses Wrangler's authenticated remote bindings, reads R2 bodies into memory and writes only the D1 search tables. It creates no public maintenance endpoint and does not save body content locally. Progress logs contain counts and failed message IDs, never subjects, body text, tokens or passwords.

The backfill processes ten messages at a time and records the source body key plus index version. Rerunning skips completed messages and retries failed/missing bodies. Existing metadata search stays available during migration; full body results become available as indexing completes. An old Worker rollback can still store mail, but its new bodies need another backfill after the search-enabled Worker is restored.

Check completeness, FTS integrity and sample matches from beyond the previews:

```sh
npm run search:backfill -- --config wrangler.production.jsonc --remote --check
```

The job exits unsuccessfully if any messages remain unindexed. D1 backups now include searchable message content and must remain private. The index can be reconstructed from D1 metadata and R2 bodies; retain both stores in backups.

References: [D1 SQL support](https://developers.cloudflare.com/d1/sql-api/sql-statements/), [SQLite FTS5 trigrams](https://sqlite.org/fts5.html#the_trigram_tokenizer), [Wrangler getPlatformProxy](https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy).
