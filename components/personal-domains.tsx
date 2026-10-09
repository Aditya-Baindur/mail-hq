'use client';
import { useState } from 'react';
import { ArrowUpRight, Globe2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { api, ErrorNote, Spinner, type Domain } from './shared';

export function PersonalDomains({ domains, refresh, notify }: {
  domains: Domain[]; refresh: () => void; notify: (message: string) => void;
}) {
  const [zoneId, setZoneId] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  async function connect() {
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await api<{ name: string; sending: boolean }>('/domains/connect', {
        method: 'POST', body: JSON.stringify({ zoneId: zoneId.trim(), token: token.trim() }),
      });
      setToken(''); setZoneId('');
      setStatus(result.sending ? `${result.name} is connected. You can now create a mailbox.` : `${result.name} can receive mail. Enable Email Sending in Cloudflare, then reconnect to enable sending.`);
      refresh(); notify(`${result.name} connected`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="panel personal-domains">
    <div className="panel-title"><h2>Connect your domain</h2><Globe2 size={18} /></div>
    <p className="muted">Use a domain in your own Cloudflare account. Its mailboxes and messages are private to your Mail HQ account.</p>
    <ol className="domain-setup-steps">
      <li>In Cloudflare, enable <strong>Email Routing</strong> and <strong>Email Sending</strong> for your domain. If you use another email provider, plan that migration before changing your mail DNS.</li>
      <li>Create an API token restricted to your domain and its account with the permissions below.</li>
      <li>Copy the <strong>Zone ID</strong> from the domain’s Overview page and connect it here.</li>
    </ol>
    <details className="setup-help">
      <summary>Required API token permissions</summary>
      <p><strong>Zone:</strong> Zone Read, Zone Settings Read, DNS Read, Email Routing Rules Edit, and Email Sending Read. <strong>Account:</strong> Workers Scripts Edit and Email Sending Edit. Restrict zone resources to this domain and account resources to its account.</p>
      <p>Connecting installs a small email relay Worker in your account. Your API token is encrypted and used for this domain’s routing and sending. Existing addresses and delivery rules are preserved.</p>
      <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Create an API token <ArrowUpRight size={14} /></a>
    </details>
    <form className="personal-domain-form" onSubmit={e => { e.preventDefault(); void connect(); }}>
      <label className="field-label" htmlFor="personal-zone-id">Cloudflare Zone ID</label>
      <Input id="personal-zone-id" value={zoneId} onChange={e => setZoneId(e.target.value.toLowerCase())} placeholder="32-character Zone ID" pattern="[a-f0-9]{32}" maxLength={32} required disabled={busy} autoComplete="off" />
      <label className="field-label" htmlFor="personal-domain-token">Domain API token</label>
      <Input id="personal-domain-token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder="Paste your scoped API token" required disabled={busy} />
      <Button className="primary" disabled={busy || !zoneId || !token}>{busy ? <Spinner /> : <Globe2 size={15} />}{busy ? 'Connecting…' : 'Connect domain'}</Button>
    </form>
    <ErrorNote message={error} />
    {status && <p role="status" className="muted">{status}</p>}
    {domains.filter(d => d.connection_ready !== null && d.connection_ready !== undefined).map(d => <div className="settings-domain" key={d.id}>
      <Globe2 size={18} /><div><strong>{d.name}</strong><p>{d.connection_ready ? d.note : 'Setup incomplete. Reconnect with a token that has the required permissions.'}</p></div>
      <Button variant="outline" onClick={() => { setZoneId(d.id); setStatus('Paste a current API token to refresh status or repair this connection.'); }}>Reconnect</Button>
    </div>)}
  </div>;
}
