import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeSnapshot, createMailPassword, handleBridge } from '../worker/src/bridge';
import { boxA, boxB, setup } from './helpers';
import { sendMail } from '../worker/src/mail';
import PostalMime from 'postal-mime';

let f: ReturnType<typeof setup>, a: Awaited<ReturnType<typeof createMailPassword>>, b: typeof a;
beforeEach(async () => {
  f = setup(); f.env.BRIDGE_HOST='bridge.example.com'; f.env.BRIDGE_API_SECRET='test-bridge-secret';
  a=await createMailPassword(f.env,'test',{mailboxId:boxA,name:'iPhone'});
  b=await createMailPassword(f.env,'test',{mailboxId:boxB,name:'iPad'});
});
afterEach(()=>f.close());
async function call(op: object, login=a, secret=f.env.BRIDGE_API_SECRET) {
  const response=await handleBridge(new Request('https://mcp.example.com/bridge/v1',{method:'POST',headers:{authorization:`Basic ${Buffer.from(`${login.address}:${login.password}`).toString('base64')}`,'x-mailhq-bridge':secret!},body:JSON.stringify(op)}),f.env);
  return {status:response.status,data:await response.json() as any};
}
const mime=(from='research@example.com',id='one')=>Buffer.from(`From: ${from}\r\nTo: friend@example.net\r\nSubject: Bridge test\r\nMessage-ID: <${id}@example.com>\r\nDate: Wed, 7 Oct 2026 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello from the phone.\r\n`).toString('base64');
async function append(folder='inbox',raw=mime(),login=a) {
  const r=await call({action:'append',folder,raw,flags:[],date:'2026-10-07T12:00:00.000Z'},login);
  expect(r.status).toBe(200); return r.data as {id:string;uid:number};
}
describe('mail-app bridge',()=>{
  it('separates mail-app credentials, requires both credentials, and applies revocation to existing sessions',async()=>{
    expect((await call({action:'login'})).status).toBe(200);
    expect((await call({action:'login'},a,'wrong')).status).toBe(401);
    expect((await call({action:'login'},{...a,password:'mhq_'+a.password})).status).toBe(401);
    expect((await call({action:'login'},{...a,address:b.address})).status).toBe(401);
    expect(f.sql.prepare('SELECT password_hash FROM mail_app_passwords WHERE id=?').get(a.id)?.password_hash).not.toBe(a.password);
    f.sql.prepare('UPDATE mail_app_passwords SET revoked_at=? WHERE id=?').run(new Date().toISOString(),a.id);
    expect((await call({action:'snapshot',folder:'inbox'})).status).toBe(401);
  });
  it('prevents reads and writes across mailboxes, including mixed UID batches',async()=>{
    const mine=await append(), other=await append('inbox',mime(),b);
    for(const op of [{action:'raw',uid:other.uid},{action:'flags',uids:[mine.uid,other.uid],operation:'add',flags:['\\Seen']},{action:'transfer',uids:[other.uid],folder:'trash',move:true},{action:'expunge',uids:[other.uid]}])
      expect((await call(op)).status).toBe(404);
    expect((await bridgeSnapshot(f.env,boxA,'inbox')).messages[0].flags).not.toContain('\\Seen');
  });
  it('keeps UIDs and exact MIME stable over reconnects and assigns a new UID after a dashboard move',async()=>{
    const m=await append(); const first=await call({action:'raw',uid:m.uid});
    expect(first.data.raw).toBe(mime());
    expect((await bridgeSnapshot(f.env,boxA,'inbox')).messages[0].uid).toBe(m.uid);
    expect((await call({action:'raw',uid:m.uid})).data.raw).toBe(first.data.raw);
    f.sql.prepare("UPDATE messages SET folder='archive' WHERE id=?").run(m.id);
    expect((await bridgeSnapshot(f.env,boxA,'archive')).messages[0].uid).toBeGreaterThan(m.uid);
    expect((await bridgeSnapshot(f.env,boxA,'inbox')).messages).toHaveLength(0);
  });
  it('synchronizes flags in both directions without clobbering concurrent dashboard stars',async()=>{
    const m=await append();f.sql.prepare('UPDATE messages SET starred=1 WHERE id=?').run(m.id);
    expect((await call({action:'flags',uids:[m.uid],operation:'add',flags:['\\Seen','\\Answered']})).status).toBe(200);
    expect(f.sql.prepare('SELECT is_read,starred FROM messages WHERE id=?').get(m.id)).toEqual({is_read:1,starred:1});
    f.sql.prepare('UPDATE messages SET is_read=0 WHERE id=?').run(m.id);
    const flags=(await bridgeSnapshot(f.env,boxA,'inbox')).messages[0].flags;
    expect(flags).toContain('\\Flagged'); expect(flags).toContain('\\Answered'); expect(flags).not.toContain('\\Seen');
  });
  it('moves to Trash on expunge and retains recoverable dashboard data when Trash is expunged',async()=>{
    const m=await append(); await call({action:'flags',uids:[m.uid],operation:'add',flags:['\\Deleted']});
    await call({action:'expunge',uids:[m.uid]}); const trash=(await bridgeSnapshot(f.env,boxA,'trash')).messages[0];
    await call({action:'flags',uids:[trash.uid],operation:'add',flags:['\\Deleted']}); await call({action:'expunge',uids:[trash.uid]});
    expect((await bridgeSnapshot(f.env,boxA,'trash')).messages).toHaveLength(0);
    expect(f.sql.prepare('SELECT folder FROM messages WHERE id=?').get(m.id)?.folder).toBe('trash');
    f.sql.prepare("UPDATE messages SET folder='inbox' WHERE id=?").run(m.id);
    expect((await bridgeSnapshot(f.env,boxA,'inbox')).messages[0].uid).toBeGreaterThan(trash.uid);
  });
  it('uses the same drafts as the composer and invalidates the UID when a dashboard draft changes',async()=>{
    const m=await append('drafts');const d=f.sql.prepare('SELECT data FROM drafts WHERE id=?').get(m.id)!;
    expect(JSON.parse(d.data as string).text).toContain('Hello from the phone');
    const data={...JSON.parse(d.data as string),subject:'Edited from the UI'};
    f.sql.prepare('UPDATE drafts SET data=? WHERE id=?').run(JSON.stringify(data),m.id);
    const next=(await bridgeSnapshot(f.env,boxA,'drafts')).messages[0];expect(next.uid).toBeGreaterThan(m.uid);
    const raw=await call({action:'raw',uid:next.uid});expect((await PostalMime.parse(Buffer.from(raw.data.raw,'base64'))).subject).toBe('Edited from the UI');
    f.sql.prepare('DELETE FROM drafts WHERE id=?').run(m.id);expect((await bridgeSnapshot(f.env,boxA,'drafts')).messages).toHaveLength(0);
  });
  it('does not send on APPEND and reconciles only the first Sent copy of an SMTP submission',async()=>{
    await append('sent');expect(f.send).not.toHaveBeenCalled();
    const op={action:'submit',raw:mime('research@example.com','smtp'),recipients:['friend@example.net']};
    expect((await call(op)).status).toBe(200);expect((await call(op)).status).toBe(200);expect(f.send).toHaveBeenCalledTimes(1);
    const before=(await bridgeSnapshot(f.env,boxA,'sent')).messages.length;
    await append('sent',op.raw);expect((await bridgeSnapshot(f.env,boxA,'sent')).messages).toHaveLength(before);
    await append('sent',op.raw);expect((await bridgeSnapshot(f.env,boxA,'sent')).messages).toHaveLength(before+1);
  });
  it('enforces sender identity and preserves envelope-only recipients as Bcc',async()=>{
    expect((await call({action:'submit',raw:mime('personal@example.com'),recipients:['friend@example.net']})).status).toBe(403);
    expect((await call({action:'submit',raw:mime(),recipients:['hidden@example.net']})).status).toBe(200);
    expect(f.send.mock.calls[0][0]).toMatchObject({from:{email:a.address},to:[],cc:[],bcc:['hidden@example.net']});
  });
  it('preserves different Sent content that reuses an SMTP Message-ID',async()=>{
    const raw=mime('research@example.com','reused');
    expect((await call({action:'submit',raw,recipients:['friend@example.net']})).status).toBe(200);
    const changed=Buffer.from(Buffer.from(raw,'base64').toString().replace('Hello from the phone.','A different message.')).toString('base64');
    await append('sent',changed);
    expect((await bridgeSnapshot(f.env,boxA,'sent')).messages).toHaveLength(2);
    await append('sent',raw);
    expect((await bridgeSnapshot(f.env,boxA,'sent')).messages).toHaveLength(2);
  });
  it('never retries ambiguous sending failures',async()=>{
    f.send.mockRejectedValueOnce(new Error('connection interrupted'));
    const op={action:'submit',raw:mime(),recipients:['friend@example.net']};
    expect((await call(op)).status).toBe(409);expect((await call(op)).status).toBe(409);expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.sql.prepare('SELECT status FROM messages').get()?.status).toBe('uncertain');
  });
  it('creates a stable MIME representation of dashboard sent mail including binary attachments',async()=>{
    const id='00000000-0000-4000-8000-000000000003'; const bytes=new Uint8Array([0,1,2,127,128,255]);
    f.objects.set('upload',bytes);f.sql.prepare('INSERT INTO attachments(id,mailbox_id,filename,content_type,size,object_key) VALUES(?,?,?,?,?,?)').run(id,boxA,'résumé.bin','application/octet-stream',bytes.length,'upload');
    await sendMail(f.env,{actor:'test',scopes:['read','send']},{mailboxId:boxA,to:['friend@example.net'],cc:[],bcc:[],subject:'Hello café',text:'Plain text',html:'<p>HTML text</p>',attachmentIds:[id],idempotencyKey:crypto.randomUUID()});
    const m=(await bridgeSnapshot(f.env,boxA,'sent')).messages[0];const raw=await call({action:'raw',uid:m.uid});
    const parsed=await PostalMime.parse(Buffer.from(raw.data.raw,'base64'),{attachmentEncoding:'arraybuffer'});
    expect(parsed.subject).toBe('Hello café');expect(parsed.html).toBe('<p>HTML text</p>');expect(new Uint8Array(parsed.attachments[0].content as ArrayBuffer)).toEqual(bytes);
    expect((await call({action:'raw',uid:m.uid})).data.raw).toBe(raw.data.raw);
  });
});
