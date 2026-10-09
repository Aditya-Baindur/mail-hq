'use client';
import { useEffect, useState } from 'react';
import { Copy, Download, KeyRound, Smartphone, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Combobox } from './ui/combobox';
import { api, ErrorNote, IconButton, Spinner, type Mailbox } from './shared';

type Connection = { id: string; name: string; address: string; revoked_at: string | null; last_used_at: string | null };
type Settings = { connections: Connection[]; host: string | null; configured: boolean; imapPort: number; smtpPort: number };
type Login = { id: string; password: string; address: string; host: string; imapPort: number; smtpPort: number };

export function MailApps({ mailboxes, notify }: { mailboxes: Mailbox[]; notify: (text: string) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [box, setBox] = useState(mailboxes.find(b => b.status === 'active')?.id || '');
  const [name, setName] = useState('iPhone');
  const [login, setLogin] = useState<Login | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() { setSettings(await api<Settings>('/mail-apps')); }
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, []);
  async function create() {
    setBusy(true); setError('');
    try {
      setLogin(await api<Login>('/mail-apps', { method: 'POST', body: JSON.stringify({ mailboxId: box, name }) }));
      await refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setError('');
    try { await api(`/mail-apps/${id}`, { method: 'DELETE' }); await refresh(); notify('Mail app access revoked'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); notify('Copied'); }
    catch { setError('Copy failed. Select and copy the value manually.'); }
  }
  return <div className="panel mail-app-panel" id="mail-apps">
    <div className="panel-title"><h2><Smartphone size={18} /> Mail apps</h2>
      <span className={`status-tag ${settings?.configured ? 'good' : 'neutral'}`}>{settings?.configured ? 'IMAP + SMTP' : 'Not configured'}</span></div>
    <p className="muted">Use Apple Mail or another mail app with a separate password for each device and mailbox.</p>
    {settings?.configured && <>
      {login ? <div className="mail-app-login" role="status">
        <strong>Your mail-app password</strong>
        <p>Save this password now. It is shown only once.</p>
        <div className="mail-app-secret"><code>{login.password}</code><IconButton label="Copy mail-app password" onClick={() => void copy(login.password)}><Copy size={16} /></IconButton></div>
        <Button asChild><a href={`/api/mail-apps/${login.id}/apple.mobileconfig`}><Download size={16} />Download Apple Mail setup</a></Button>
        <p>On your iPhone, open this page in Safari and download the setup. Open Settings → Profile Downloaded → Install, then enter this app password when asked. The download contains only email settings; it does not include your password. iOS may label the profile “Not Signed.”</p>
        <div className="settings-row"><span>Username</span><code>{login.address}</code></div>
        <div className="settings-row"><span>Host Name · both servers</span><code>{login.host}</code></div>
        <div className="settings-row"><span>Incoming port · IMAP</span><code>{login.imapPort}</code></div>
        <div className="settings-row"><span>Outgoing port · SMTP</span><code>{login.smtpPort}</code></div>
        <p>Enter only the hostname in each Host Name field. Ports belong in the separate Server Port settings.</p>
        <p>Use SSL and Password authentication for both servers. Enter the same full email address and password in both sections.</p>
        <Button variant="outline" onClick={() => setLogin(null)}>I saved my password</Button>
      </div> : <form className="mail-app-form" onSubmit={e => { e.preventDefault(); void create(); }}>
        <label className="field-label">Mailbox</label>
        <Combobox label="Mail app mailbox" value={box} onValueChange={setBox} options={mailboxes.filter(b => b.status === 'active').map(b => ({ value: b.id, label: b.address }))} />
        <label className="field-label" htmlFor="mail-app-device">Device name</label>
        <Input id="mail-app-device" value={name} onChange={e => setName(e.target.value)} maxLength={100} required />
        <Button disabled={busy || !box || !name.trim()}>{busy ? <Spinner /> : <KeyRound size={16} />}Create app password</Button>
      </form>}
      <details className="mail-app-help"><summary>Add to Apple Mail on iPhone</summary>
        <p>Recommended: use the Apple Mail setup download beside your connection below. In Safari, allow the download, then open Settings → Profile Downloaded → Install and enter your app password. This fills in the server names, ports and SSL settings automatically.</p>
        <p>For manual setup:</p>
        <ol><li>Open Settings → Apps → Mail → Mail Accounts → Add Account. Enter your email if prompted, then choose Add Other Account → Mail Account. Some iOS versions label this Other → Add Mail Account.</li>
          <li>Enter your name, mailbox email, and the app password above. Choose IMAP.</li>
          <li>For both Incoming and Outgoing Mail Server, enter only <strong>{settings.host}</strong> in Host Name, your full mailbox email as Username, and your app password as Password. Fill in outgoing credentials even if they are labeled optional.</li>
          <li>Use SSL: incoming port <strong>{settings.imapPort}</strong>, outgoing port <strong>{settings.smtpPort}</strong>, with Password authentication. If iOS cannot detect the ports, use the setup download above.</li>
          <li>Under Account → Advanced → Mailbox Behaviors, use the server folders Drafts, Sent, Trash and Archive.</li></ol>
        <p className="muted">Mail, read status, stars and folders sync with Mail HQ. Generic IMAP on iPhone uses Fetch for background updates. Expunged Trash remains recoverable in Mail HQ.</p>
      </details>
      {settings.connections.map(c => <div className={`token-row ${c.revoked_at ? 'revoked' : ''}`} key={c.id}>
        <Smartphone size={18} /><div className="token-info"><strong>{c.name}</strong><p>{c.address}</p>
          <small>{c.revoked_at ? 'Revoked' : c.last_used_at ? `Last used ${new Date(c.last_used_at).toLocaleString()}` : 'Not used yet'}</small>
          {!c.revoked_at && <div><Button variant="link" asChild><a href={`/api/mail-apps/${c.id}/apple.mobileconfig`}><Download size={14} />Download Apple Mail setup</a></Button></div>}</div>
        {!c.revoked_at && <IconButton label={`Revoke ${c.name}`} disabled={busy} onClick={() => void revoke(c.id)}><Trash2 size={16} /></IconButton>}
      </div>)}
    </>}
    <ErrorNote message={error} />
  </div>;
}
