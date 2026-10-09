import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: { '@': new URL('.', import.meta.url).pathname, 'cloudflare:workers': new URL('./tests/cloudflare-workers.ts', import.meta.url).pathname } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', pool: 'forks',
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } } },
});
