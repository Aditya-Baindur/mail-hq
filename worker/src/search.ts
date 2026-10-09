import { Parser } from 'htmlparser2';
import { now, type Env } from './model';

export const SEARCH_VERSION = 1;
export const SEARCH_QUERY_LENGTH = 200;
export const SEARCH_CHUNK_LENGTH = 100_000;
type Body = { text?: string; html?: string };
const hiddenTags = new Set(['head', 'script', 'style', 'template', 'noscript']);
const blockTags = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'div', 'dl', 'dt', 'dd', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul']);
const normalize = (text: string) => text.replace(/\0/g, '').replace(/\s+/gu, ' ').trim();

/** Extract readable HTML locally: no scripts, network requests or remote images. */
export function htmlSearchText(html: string) {
  const parts: string[] = [];
  let hidden = 0;
  const parser = new Parser({
    onopentag(name, attributes) {
      if (hiddenTags.has(name)) hidden++;
      if (hidden) return;
      if (blockTags.has(name)) parts.push(' ');
      if (name === 'img' && attributes.alt) parts.push(' ', attributes.alt, ' ');
    },
    ontext(text) { if (!hidden) parts.push(text); },
    onclosetag(name) {
      if (hiddenTags.has(name)) hidden--;
      if (!hidden && blockTags.has(name)) parts.push(' ');
    },
  }, { decodeEntities: true });
  parser.end(html);
  return normalize(parts.join(''));
}

export function searchableBody(body: Body) {
  const text = normalize(body.text || '');
  const html = body.html ? htmlSearchText(body.html) : '';
  // Some multipart messages have a placeholder plain-text alternative. Index
  // both representations when they differ, without retaining HTML in D1.
  return html && html !== text ? [text, html].filter(Boolean).join('\n') : text;
}

export function* searchChunks(text: string) {
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + SEARCH_CHUNK_LENGTH);
    // Do not cut a UTF-16 surrogate pair when serializing a D1 bound parameter.
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    yield text.slice(start, end);
    if (end === text.length) break;
    start = end - SEARCH_QUERY_LENGTH;
    if (/[\uDC00-\uDFFF]/.test(text[start])) start--;
  }
}

/** Include these in the same transaction that creates the message. */
export function messageSearchStatements(env: Env, id: string, bodyKey: string, body: Body) {
  const statements = [env.DB.prepare('DELETE FROM message_search_chunks WHERE message_id=? AND part>0').bind(id)];
  let part = 1;
  for (const text of searchChunks(searchableBody(body))) {
    statements.push(env.DB.prepare('INSERT INTO message_search_chunks(message_id,part,text) VALUES(?,?,?)').bind(id, part++, text));
  }
  statements.push(env.DB.prepare(`INSERT INTO message_search_state(message_id,body_key,version,indexed_at) VALUES(?,?,?,?)
    ON CONFLICT(message_id) DO UPDATE SET body_key=excluded.body_key,version=excluded.version,indexed_at=excluded.indexed_at`)
    .bind(id, bodyKey, SEARCH_VERSION, now()));
  return statements;
}

export function messageSearchFilter(query: string) {
  const text = normalize(query).slice(0, SEARCH_QUERY_LENGTH);
  if (!text) return null;
  // MATCH syntax is never accepted from the user: the entire input is one
  // escaped literal substring. Short queries cannot use a trigram index.
  if ([...text].length >= 3) return {
    sql: `m.id IN (SELECT c.message_id FROM message_search_fts
      JOIN message_search_chunks c ON c.id=message_search_fts.rowid WHERE message_search_fts MATCH ?)`,
    value: `"${text.replace(/"/g, '""')}"`,
  };
  return {
    sql: "m.id IN (SELECT message_id FROM message_search_chunks WHERE text LIKE ? ESCAPE '\\')",
    value: `%${text.replace(/[\\%_]/g, '\\$&')}%`,
  };
}

/** Resumable maintenance job. Logs/progress expose IDs and counts, never mail. */
export async function backfillSearchBatch(env: Env, after = '', limit = 10) {
  const rows = await env.DB.prepare(`SELECT m.id,m.body_key FROM messages m LEFT JOIN message_search_state s ON s.message_id=m.id
    WHERE m.id>? AND (s.message_id IS NULL OR s.version<>? OR s.body_key<>m.body_key) ORDER BY m.id LIMIT ?`)
    .bind(after, SEARCH_VERSION, Math.min(50, Math.max(1, limit))).all<{ id: string; body_key: string }>();
  let indexed = 0;
  const failed: { id: string; reason: string }[] = [];
  for (const m of rows.results) {
    try {
      const object = await env.MAIL_STORE.get(m.body_key);
      if (!object) { failed.push({ id: m.id, reason: 'missing_body' }); continue; }
      const body = await object.json<Body>();
      if ((body.text !== undefined && typeof body.text !== 'string') || (body.html !== undefined && typeof body.html !== 'string')) {
        failed.push({ id: m.id, reason: 'invalid_body' }); continue;
      }
      await env.DB.batch(messageSearchStatements(env, m.id, m.body_key, body));
      indexed++;
    } catch { failed.push({ id: m.id, reason: 'index_failed' }); }
  }
  return { indexed, failed, cursor: rows.results.at(-1)?.id || null };
}
