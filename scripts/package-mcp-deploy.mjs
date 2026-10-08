// Cloudflare MCP fallback for environments where Wrangler cannot reach the network.
// The regular `npm run deploy` uses native Workers Static Assets instead.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, relative } from 'node:path';
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}
const modules = files('dist/server')
  .filter((p) => p.endsWith('.js'))
  .map((p) => ({ name: relative('dist/server', p), content: readFileSync(p, 'utf8') }));
const assets = Object.fromEntries(
  files('dist/client/_next/static').map((p) => [
    '/' + relative('dist/client', p),
    {
      body: readFileSync(p).toString('base64'),
      type: p.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : p.endsWith('.woff2')
          ? 'font/woff2'
          : 'text/javascript; charset=utf-8',
    },
  ]),
);
modules.push({
  name: 'embedded-assets.js',
  content: 'export default ' + JSON.stringify(assets) + ';',
});
modules.push({
  name: 'deploy-entry.js',
  content: `import worker from './index.js';import assets from './embedded-assets.js';export default {...worker,fetch(request,env,ctx){return worker.fetch(request,{...env,ASSETS:{fetch:async(r)=>{const a=assets[new URL(r.url).pathname];return a?new Response(r.method==='HEAD'?null:Uint8Array.from(atob(a.body),c=>c.charCodeAt(0)),{headers:{'Content-Type':a.type,'Cache-Control':'private, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'}}):new Response('Not found',{status:404});}}},ctx);}};`,
});
const config = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'));
const metadata = {
  main_module: 'deploy-entry.js',
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags,
  bindings: [
    { type: 'd1', name: 'DB', database_id: config.d1_databases[0].database_id },
    { type: 'r2_bucket', name: 'MAIL_STORE', bucket_name: config.r2_buckets[0].bucket_name },
    { type: 'send_email', name: 'EMAIL' },
    ...Object.entries(config.vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
  ],
  keep_bindings: ['secret_text'],
  observability: { enabled: true, redact_query_string: true },
};
mkdirSync('.local', { recursive: true });
writeFileSync(
  '.local/deploy.json.gz.b64',
  gzipSync(JSON.stringify({ metadata, modules })).toString('base64'),
);
console.log(
  `Packaged ${modules.length} modules and ${Object.keys(assets).length} private frontend assets.`,
);
