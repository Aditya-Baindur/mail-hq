// Wrangler's authenticated remote bindings: no public maintenance route,
// additional production secret, or local copy of email content is created.
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { build } from 'esbuild';
import { getPlatformProxy } from 'wrangler';

const { values } = parseArgs({ options: { config: { type: 'string', default: 'wrangler.jsonc' }, remote: { type: 'boolean', default: false }, check: { type: 'boolean', default: false } } });
if (!values.remote) throw new Error('Pass --remote with the intended Wrangler config. Unit tests use isolated local fixtures.');
const configPath = resolve(values.config);
const parsed = ts.parseConfigFileTextToJson(configPath, await readFile(configPath, 'utf8'));
if (parsed.error) throw new Error('Invalid Wrangler configuration');
const config = parsed.config;
const database = config.d1_databases?.find(b => b.binding === 'DB');
const bucket = config.r2_buckets?.find(b => b.binding === 'MAIL_STORE');
if (!config.account_id || !database?.database_id || !bucket?.bucket_name) throw new Error('Set the account ID and existing DB/MAIL_STORE identifiers in the selected config.');
await mkdir('.local', { recursive: true });
const directory = await mkdtemp(resolve('.local/search-maintenance-'));
let proxy;
try {
  const bindingConfig = join(directory, 'wrangler.json');
  await writeFile(bindingConfig, JSON.stringify({ name: `${config.name}-search-maintenance`, account_id: config.account_id,
    compatibility_date: config.compatibility_date, compatibility_flags: ['nodejs_compat'], workers_dev: false,
    d1_databases: [{ binding: 'DB', database_id: database.database_id, database_name: database.database_name, remote: true }],
    r2_buckets: [{ binding: 'MAIL_STORE', bucket_name: bucket.bucket_name, remote: true }],
  }), { mode: 0o600 });
  const modulePath = join(directory, 'search.mjs');
  await build({ entryPoints: ['worker/src/search.ts'], bundle: true, platform: 'node', format: 'esm', outfile: modulePath, logLevel: 'silent' });
  const { backfillSearchBatch, messageSearchFilter, SEARCH_VERSION } = await import(pathToFileURL(modulePath).href);
  proxy = await getPlatformProxy({ configPath: bindingConfig, persist: false, envFiles: [], remoteBindings: true });
  const env = proxy.env;
  console.log(JSON.stringify({ target: config.name, database: database.database_name, mode: values.check ? 'check' : 'backfill' }));
  let indexed = 0, failures = 0, cursor = '';
  if (!values.check) {
    for (;;) {
      const batch = await backfillSearchBatch(env, cursor, 10);
      indexed += batch.indexed;
      failures += batch.failed.length;
      console.log(JSON.stringify({ indexed, failures }));
      if (batch.failed.length) console.error(JSON.stringify({ failed: batch.failed }));
      if (!batch.cursor) break;
      cursor = batch.cursor;
    }
  }
  const counts = await env.DB.prepare(`SELECT COUNT(*) AS messages,
    SUM(CASE WHEN s.message_id IS NOT NULL AND s.version=? AND s.body_key=m.body_key THEN 1 ELSE 0 END) AS indexed
    FROM messages m LEFT JOIN message_search_state s ON s.message_id=m.id`).bind(SEARCH_VERSION).first();
  // Compare FTS to its external content without exporting message text.
  await env.DB.prepare("INSERT INTO message_search_fts(message_search_fts,rank) VALUES('integrity-check',1)").run();
  const samples = await env.DB.prepare(`SELECT c.message_id,c.text,m.mailbox_id,m.subject,m.snippet,m.sender,m.recipients
    FROM message_search_chunks c JOIN messages m ON m.id=c.message_id WHERE c.part=1 AND length(c.text)>400 ORDER BY c.id LIMIT 10`).all();
  let verified = 0;
  for (const sample of samples.results) {
    const metadata = `${sample.subject} ${sample.snippet} ${sample.sender} ${sample.recipients}`.toLowerCase();
    const phrase = sample.text.slice(250).match(/[\p{L}\p{N}][\p{L}\p{N} ,.!?:;-]{19,79}/u)?.[0]?.trim();
    if (!phrase || metadata.includes(phrase.toLowerCase())) continue;
    const filter = messageSearchFilter(phrase);
    const found = await env.DB.prepare(`SELECT m.id FROM messages m WHERE m.mailbox_id=? AND m.id=? AND ${filter.sql}`)
      .bind(sample.mailbox_id, sample.message_id, filter.value).first();
    if (!found) throw new Error('Full-body search verification failed');
    verified++;
  }
  const pending = Number(counts.messages) - Number(counts.indexed || 0);
  console.log(JSON.stringify({ messages: counts.messages, indexed: counts.indexed || 0, pending, fullBodyChecks: verified, ftsIntegrity: 'passed' }));
  if (pending || failures) process.exitCode = 1;
} finally {
  await proxy?.dispose();
  await rm(directory, { recursive: true, force: true });
}
