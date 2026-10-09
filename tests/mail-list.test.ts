import { afterEach, describe, expect, it } from 'vitest';
import { boxA, boxB, setup } from './helpers';
import { listMessages } from '../worker/src/mail';
import { fetchApi } from '../worker/src/index';
import type { Principal } from '../worker/src/model';

const owner: Principal = { actor: 'owner', scopes: ['read', 'send'] };
let fixture: ReturnType<typeof setup>;
afterEach(() => fixture?.close());
function seed() {
  fixture = setup();
  const insert = fixture.sql.prepare(`INSERT INTO messages
    (id,mailbox_id,thread_id,direction,folder,sender,sender_name,recipients,subject,snippet,body_key,is_read,starred,created_at)
    VALUES(?,?,?,'inbound',?,?,?,?,?,'Message preview','body',?,?,?)`);
  for (let n = 0; n < 57; n++) {
    const id = String(n).padStart(3, '0');
    insert.run(
      id,
      n < 47 ? boxA : boxB,
      id,
      n === 56 ? 'trash' : n === 55 ? 'spam' : n === 54 ? 'archive' : 'inbox',
      'sender@example.com',
      n < 12 ? 'Alice Chen' : 'Bob Smith',
      '["recipient@example.com"]',
      n < 17 ? 'Project 100% complete' : 'Weekly update',
      n % 2,
      n % 3 === 0 ? 1 : 0,
      '2026-10-08T12:00:00.000Z',
    );
  }
  return fixture.env;
}

describe('mailbox totals and pagination', () => {
  it('returns the actual total on every page, even with identical timestamps', async () => {
    const env = seed();
    const first = await listMessages(env, owner, {});
    expect(first.messages).toHaveLength(40);
    expect(first.total).toBe(54);
    expect(first.nextCursor).not.toBeNull();
    const second = await listMessages(env, owner, { cursor: first.nextCursor! });
    expect(second.messages).toHaveLength(14);
    expect(second.total).toBe(54);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.messages, ...second.messages].map((m) => m.id)).size).toBe(54);
  });
  it('counts the complete mailbox with unread, starred, and search filters applied', async () => {
    const env = seed();
    expect((await listMessages(env, owner, { mailboxId: boxA })).total).toBe(47);
    expect((await listMessages(env, owner, { mailboxId: boxA, unread: true })).total).toBe(24);
    expect(
      (await listMessages(env, owner, { mailboxId: boxA, unread: true, starred: true, q: '100%' }))
        .total,
    ).toBe(3);
    expect((await listMessages(env, owner, { q: 'Alice Chen' })).total).toBe(12);
    expect((await listMessages(env, owner, { q: 'recipient@example.com' })).total).toBe(54);
    expect((await listMessages(env, owner, { q: 'does not exist' })).total).toBe(0);
    expect((await listMessages(env, owner, { q: '100_' })).total).toBe(0);
    expect((await listMessages(env, owner, { starred: true })).total).toBe(19);
  });
  it('never exposes another mailbox in an agent’s count', async () => {
    const env = seed();
    const agent: Principal = { ...owner, mailboxId: boxA };
    const result = await listMessages(env, agent, { mailboxId: boxB, limit: 2 });
    expect(result.total).toBe(47);
    expect(result.messages.every((m) => m.mailbox_id === boxA)).toBe(true);
    expect((await listMessages(env, agent, { cursor: result.nextCursor! })).total).toBe(47);
  });
  it('searches every folder and mailbox with stable totals across pages', async () => {
    const env = seed();
    const first = await listMessages(env, owner, { folder: 'all', q: 'recipient@example.com' });
    const second = await listMessages(env, owner, { folder: 'all', q: 'recipient@example.com', cursor: first.nextCursor! });
    expect(first.total).toBe(57);
    expect(second.total).toBe(57);
    const messages = [...first.messages, ...second.messages];
    expect(new Set(messages.map((m) => m.id)).size).toBe(57);
    expect(new Set(messages.map((m) => m.folder))).toEqual(new Set(['inbox', 'archive', 'spam', 'trash']));
    expect(new Set(messages.map((m) => m.mailbox_id))).toEqual(new Set([boxA, boxB]));
    // An unfiltered all-folder list must also produce valid SQL.
    expect((await listMessages(env, owner, { folder: 'all' })).total).toBe(57);
    const agent: Principal = { ...owner, mailboxId: boxB };
    const scoped = await listMessages(env, agent, { folder: 'all', mailboxId: boxA, q: 'recipient@example.com' });
    expect(scoped.total).toBe(10);
    expect(scoped.messages.every((m) => m.mailbox_id === boxB)).toBe(true);
    await expect(listMessages(env, { ...owner, scopes: ['send'] }, { folder: 'all' })).rejects.toThrow('Read access');
  });
  it('returns folder and starred totals for each mailbox in bootstrap', async () => {
    const env = seed();
    const response = await fetchApi(new Request('http://localhost/api/bootstrap'), env, {
      waitUntil() {},
    } as unknown as ExecutionContext);
    expect(response?.status).toBe(200);
    const data = (await response!.json()) as {
      counts: { mailbox_id: string; folder: string; count: number; unread: number }[];
    };
    expect(data.counts.find((c) => c.mailbox_id === boxA && c.folder === 'inbox')).toMatchObject({
      count: 47,
      unread: 24,
    });
    expect(data.counts.find((c) => c.mailbox_id === boxA && c.folder === 'starred')).toMatchObject({
      count: 16,
      unread: 8,
    });
    expect(data.counts.find((c) => c.mailbox_id === boxB && c.folder === 'starred')).toMatchObject({
      count: 3,
    });
  });
});
