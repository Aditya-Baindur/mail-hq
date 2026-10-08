import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import type { Env } from '../worker/src/model';
export const boxA = '00000000-0000-4000-8000-000000000001',
  boxB = '00000000-0000-4000-8000-000000000002';
export function setup() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync('migrations/0001_mail.sql', 'utf8'));
  sql.exec(readFileSync('migrations/0002_managed_routing.sql', 'utf8'));
  sql.exec(`
    INSERT INTO domains(id,name,receiving,sending,note) VALUES
      ('11111111111111111111111111111111','example.com',1,1,NULL),
      ('22222222222222222222222222222222','external.example',0,0,'Mail is hosted by iCloud.');
    INSERT INTO protected_addresses(address,domain_id,routing_rule_id) VALUES
      ('hello@example.com','11111111111111111111111111111111','test-hello-rule'),
      ('existing@example.com','11111111111111111111111111111111','test-existing-rule');
  `);
  sql.exec("UPDATE domains SET sending=1 WHERE name='example.com'");
  for (const [id, name] of [
    [boxA, 'research'],
    [boxB, 'personal'],
  ])
    sql
      .prepare(
        "INSERT INTO mailboxes(id,domain_id,address,name,status) VALUES(?,'11111111111111111111111111111111',?,?,'active')",
      )
      .run(id, `${name}@example.com`, name);
  function prepare(query: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) {
        values = args;
        return statement;
      },
      async first(column?: string) {
        const row = sql.prepare(query).get(...(values as never[]));
        return column ? (row?.[column] ?? null) : (row ?? null);
      },
      async all() {
        const results = sql.prepare(query).all(...(values as never[]));
        return { results, success: true, meta: {} };
      },
      async run() {
        const r = sql.prepare(query).run(...(values as never[]));
        return { success: true, results: [], meta: { changes: Number(r.changes) } };
      },
    };
    return statement;
  }
  const objects = new Map<string, Uint8Array>();
  const store = {
    async put(key: string, data: string | ArrayBuffer | Uint8Array) {
      objects.set(
        key,
        typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data),
      );
      return {};
    },
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes
        ? {
            body: new Blob([bytes.slice().buffer]).stream(),
            size: bytes.length,
            async arrayBuffer() {
              return bytes.slice().buffer;
            },
            async text() {
              return new TextDecoder().decode(bytes);
            },
            async json() {
              return JSON.parse(new TextDecoder().decode(bytes));
            },
          }
        : null;
    },
    async head(key: string) {
      return objects.has(key) ? {} : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  const send = vi.fn(async (_message: EmailMessageBuilder) => ({
    messageId: '<provider-id@cloudflare.email>',
  }));
  const env = {
    DB: {
      prepare,
      async batch(statements: { run: () => Promise<unknown> }[]) {
        sql.exec('BEGIN');
        try {
          const r = [];
          for (const s of statements) r.push(await s.run());
          sql.exec('COMMIT');
          return r;
        } catch (e) {
          sql.exec('ROLLBACK');
          throw e;
        }
      },
    },
    MAIL_STORE: store,
    EMAIL: { send },
    ACCOUNT_ID: '33333333333333333333333333333333',
    ACCESS_TEAM_DOMAIN: 'https://test-team.cloudflareaccess.com',
    ACCESS_AUD: 'test-access-audience',
    APP_ORIGIN: 'https://mail.example.com',
    MCP_HOST: 'mcp.mail.example.com',
    EMAIL_WORKER_NAME: 'mail-hq',
    LOCAL_DEV: 'true',
  } as unknown as Env;
  return { env, sql, objects, send, close: () => sql.close() };
}
