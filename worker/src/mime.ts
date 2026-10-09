import { AppError, type Attachment, type Env, type Message } from './model';

export const b64 = (value: Uint8Array | string) => Buffer.from(value).toString('base64');
const clean = (s: string) => s.replace(/[\r\n]/g, ' ');
const encoded = (s: string) => {
  const words: string[] = []; let chunk = '';
  for (const char of clean(s)) {
    if (Buffer.byteLength(chunk + char) > 42) { words.push(`=?UTF-8?B?${b64(chunk)}?=`); chunk = ''; }
    chunk += char;
  }
  words.push(`=?UTF-8?B?${b64(chunk)}?=`);
  return words.join('\r\n ');
};
const wrapped = (s: string) => s.match(/.{1,76}/g)?.join('\r\n') || '';
const part = (type: string, body: string) =>
  `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapped(b64(body))}\r\n`;

// Deterministic boundaries, headers and encodings make sizes and byte ranges stable.
export async function buildMime(env: Env, m: Pick<Message, 'id' | 'mailbox_id' | 'sender' | 'sender_name' | 'recipients' | 'cc' | 'bcc' | 'subject' | 'created_at' | 'message_id' | 'in_reply_to' | 'refs'>,
  body: { text?: string; html?: string }, attachments: Attachment[]) {
  const boundary = `mhq_${m.id.replace(/[^a-zA-Z0-9]/g, '')}`;
  const headers = [
    `From: ${encoded(m.sender_name || m.sender)} <${clean(m.sender)}>`,
    `To: ${(JSON.parse(m.recipients) as string[]).map(clean).join(', ')}`,
    `Subject: ${encoded(m.subject)}`,
    `Date: ${new Date(m.created_at).toUTCString()}`,
    `Message-ID: ${clean(m.message_id || `<${m.id}@mailhq.local>`)}`,
    'MIME-Version: 1.0',
  ];
  for (const [name, value] of [['Cc', (JSON.parse(m.cc) as string[]).join(', ')], ['Bcc', (JSON.parse(m.bcc) as string[]).join(', ')], ['In-Reply-To', m.in_reply_to], ['References', m.refs]])
    if (value) headers.push(`${name}: ${clean(value)}`);
  const alternative = `Content-Type: multipart/alternative; boundary="${boundary}_alt"\r\n\r\n--${boundary}_alt\r\n${part('text/plain', body.text || '')}` +
    (body.html ? `--${boundary}_alt\r\n${part('text/html', body.html)}` : '') + `--${boundary}_alt--\r\n`;
  if (!attachments.length) return new TextEncoder().encode(headers.join('\r\n') + '\r\n' + alternative);
  let mime = headers.join('\r\n') + `\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${alternative}`;
  for (const a of attachments) {
    const object = await env.MAIL_STORE.get(a.object_key);
    if (!object) throw new AppError(503, 'Message attachment is temporarily unavailable');
    mime += `--${boundary}\r\nContent-Type: ${clean(a.content_type)}\r\nContent-Disposition: ${a.content_id ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}\r\n`;
    if (a.content_id) mime += `Content-ID: <${clean(a.content_id).replace(/[<>]/g, '')}>\r\n`;
    mime += `Content-Transfer-Encoding: base64\r\n\r\n${wrapped(b64(new Uint8Array(await object.arrayBuffer())))}\r\n`;
  }
  return new TextEncoder().encode(mime + `--${boundary}--\r\n`);
}
