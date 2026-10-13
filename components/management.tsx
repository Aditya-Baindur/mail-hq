'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Combobox } from './ui/combobox';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { MailApps } from './mail-apps';
import { Billing } from './billing';
import { PersonalDomains } from './personal-domains';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from './ui/alert-dialog';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bot,
  Check,
  Circle,
  Copy,
  Database,
  Globe2,
  KeyRound,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Unplug,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  api,
  bytes,
  dateLabel,
  Empty,
  ErrorNote,
  IconButton,
  Modal,
  Spinner,
  type Bootstrap,
  type Domain,
  type Mailbox,
} from './shared';

export function CreateMailbox({
  domains,
  onClose,
  onCreated,
}: {
  domains: Domain[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [local, setLocal] = useState('');
  const [domain, setDomain] = useState(domains.find((d) => d.receiving)?.id || '');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#666666');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api('/mailboxes', {
        method: 'POST',
        body: JSON.stringify({ localPart: local, domainId: domain, name, color }),
      });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Create mailbox"
      subtitle="Add an address on a connected domain."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {!domains.some(d => d.receiving) && <p className="muted">Connect your domain in Settings first, then create your first mailbox.</p>}
        <label className="field-label">Email address</label>
        <div className="address-input">
          <Input
            required
            autoFocus
            placeholder="e.g. studio"
            value={local}
            onChange={(e) => setLocal(e.target.value.toLowerCase())}
            pattern="[a-zA-Z0-9]+([._-][a-zA-Z0-9]+)*"
            maxLength={64}
            aria-label="Email username"
          />
          <span>@</span>
          <Combobox
            label="Email domain"
            className="domain-combobox"
            searchPlaceholder="Search domains…"
            emptyText="No domains found."
            value={domain}
            onValueChange={setDomain}
            options={domains.map((d) => ({
              value: d.id,
              label: d.name,
              disabled: !d.receiving,
              description: d.receiving ? 'Email enabled' : 'Receiving not configured',
            }))}
          />
        </div>
        <label className="field-label" htmlFor="box-name">
          Sender name <small>Shown to recipients · optional</small>
        </label>
        <Input
          id="box-name"
          className="input"
          placeholder="Your name or organization"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
        />
        <label className="field-label">Mailbox color</label>
        <div className="color-picker">
          {['#666666', '#0070f3', '#0a7f45', '#a35200', '#9f4b61', '#7373a3'].map((c) => (
            <button
              type="button"
              key={c}
              style={{ background: c }}
              aria-label={`Choose ${c}`}
              aria-pressed={c === color}
              onClick={() => setColor(c)}
            >
              {c === color && <Check size={16} />}
            </button>
          ))}
        </div>
        <div className="quiet-note">
          <ShieldCheck size={17} />
          <span>
            Existing addresses and delivery rules are protected. Only this new mailbox will be
            added.
          </span>
        </div>
        <ErrorNote message={error} />
        <div className="modal-actions">
          <Button
            variant="outline"
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button className="primary" disabled={busy || !domain}>
            {busy ? <Spinner /> : <Plus size={16} />}Create mailbox
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function Mailboxes({
  data,
  onCreate,
  onOpen,
  onDeleted,
}: {
  data: Bootstrap;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onDeleted: (mailbox: Mailbox) => void;
}) {
  const [deleting, setDeleting] = useState<Mailbox | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const deleteTrigger = useRef<HTMLElement | null>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const confirmed =
    !!deleting && confirmation.trim().toLowerCase() === deleting.address.toLowerCase();
  async function removeMailbox() {
    if (!deleting || !confirmed || deletingBusy) return;
    setDeletingBusy(true);
    setDeleteError('');
    try {
      await api(`/mailboxes/${deleting.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ address: confirmation.trim() }),
      });
      onDeleted(deleting);
      setDeleting(null);
    } catch (error) {
      setDeleteError((error as Error).message);
    } finally {
      setDeletingBusy(false);
    }
  }
  return (
    <div className="section-page">
      <div className="section-heading">
        <div>
          <h1>Mailboxes</h1>
          <p>Manage your email addresses.</p>
        </div>
        <Button ref={createTrigger} className="primary" onClick={onCreate}>
          <Plus size={16} />
          Create mailbox
        </Button>
      </div>
      {data.mailboxes.length ? (
        <div className="mailbox-grid">
          {data.mailboxes.map((b) => (
            <div className="mailbox-entry" key={b.id}>
              <button
                className="mailbox-card"
                onClick={() => onOpen(b.id)}
                aria-label={`Open ${b.address}`}
              >
                <span
                  className="mailbox-card-icon"
                  style={{ color: b.color, background: `${b.color}15` }}
                >
                  <Mail size={23} />
                </span>
                <span className={`status-tag ${b.status === 'active' ? 'good' : 'warning'}`}>
                  <span />
                  {b.status}
                </span>
                <h3>{b.name}</h3>
                <p>{b.address}</p>
                <div className="mailbox-card-bottom">
                  <span>{b.unread ? `${b.unread} unread` : 'All caught up'}</span>
                  <ArrowUpRight size={17} />
                </div>
                {b.error && <small className="error-text">{b.error}</small>}
              </button>
              <IconButton
                label={`Delete ${b.address}`}
                className="mailbox-delete"
                onClick={() => {
                  deleteTrigger.current = document.activeElement as HTMLElement;
                  setConfirmation('');
                  setDeleteError('');
                  setDeleting(b);
                }}
              >
                <Trash2 size={16} />
              </IconButton>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-card">
          <Empty
            title="No mailboxes yet"
            description="Create an email address to send and receive mail."
            action={
              <Button className="primary" onClick={onCreate}>
                <Plus size={16} />
                Create mailbox
              </Button>
            }
          />
        </div>
      )}
      <div className="subsection-heading">
        <h2>Connected domains</h2>
        <span>{data.domains.length} domains</span>
      </div>
      <div className="domain-table">
        {data.domains.map((d) => (
          <div className="domain-row" key={d.id}>
            <Globe2 size={19} />
            <div>
              <strong>{d.name}</strong>
              <p>{d.note || 'Ready for new mailboxes'}</p>
            </div>
            <span className={`status-tag ${d.receiving ? 'good' : 'neutral'}`}>
              {d.receiving ? 'Receiving ready' : 'External mail'}
            </span>
            <span className={`status-tag ${d.sending ? 'good' : 'neutral'}`}>
              {d.sending ? 'Sending ready' : 'Sending not enabled'}
            </span>
          </div>
        ))}
      </div>
      {deleting && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !deletingBusy) setDeleting(null);
          }}
        >
          <AlertDialogContent
            onEscapeKeyDown={(event) => {
              if (deletingBusy) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              (deleteTrigger.current?.isConnected
                ? deleteTrigger.current
                : createTrigger.current
              )?.focus();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Delete email address?</AlertDialogTitle>
              <AlertDialogDescription>
                Permanently delete <strong className="break-all">{deleting.address}</strong> and all
                its emails, drafts, and attachments. Its app passwords and agent connections will
                stop working. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <form
              className="mailbox-delete-form"
              onSubmit={(event) => {
                event.preventDefault();
                void removeMailbox();
              }}
            >
              <label className="field-label" htmlFor="delete-mailbox-address">
                Type the email address to confirm
              </label>
              <Input
                id="delete-mailbox-address"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={deletingBusy}
                aria-invalid={!!deleteError}
                placeholder={deleting.address}
              />
              <ErrorNote message={deleteError} />
              <AlertDialogFooter>
                <AlertDialogCancel type="button" disabled={deletingBusy}>
                  Cancel
                </AlertDialogCancel>
                <Button type="submit" variant="destructive" disabled={!confirmed || deletingBusy}>
                  {deletingBusy ? <Spinner /> : <Trash2 size={16} />}
                  {deletingBusy ? 'Deleting…' : 'Delete address'}
                </Button>
              </AlertDialogFooter>
            </form>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

type Token = {
  kind?: 'oauth' | 'manual';
  id: string;
  name: string;
  address: string;
  scopes: string[];
  prefix: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
};
function connectionStatus(token: Token, mailboxes: Mailbox[], now: number) {
  if (token.revoked_at) return 'Revoked';
  if (new Date(token.expires_at).getTime() <= now) return 'Expired';
  if (!mailboxes.some(box => box.address === token.address && box.status === 'active'))
    return 'Mailbox inactive';
  return 'Active';
}

export function Agents({
  mailboxes,
  mcpUrl,
  notify,
}: {
  mailboxes: Mailbox[];
  mcpUrl: string;
  notify: (message: string) => void;
}) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [space, setSpace] = useState('active');
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState('');
  const [revokeError, setRevokeError] = useState('');
  const [revoking, setRevoking] = useState<Token | null>(null);
  const [revokingBusy, setRevokingBusy] = useState(false);
  const revokeTrigger = useRef<HTMLElement | null>(null);
  const connectTrigger = useRef<HTMLButtonElement>(null);
  const refreshVersion = useRef(0);
  const canConnect = mailboxes.some(box => box.status === 'active');
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    setRefreshing(true);
    try {
      const [manual, oauth] = await Promise.all([
        api<{ tokens: Token[] }>('/tokens'),
        api<{ connections: Omit<Token, 'prefix'>[] }>('/oauth/connections'),
      ]);
      if (version !== refreshVersion.current) return;
      setTokens([
        ...oauth.connections.map(t => ({ ...t, kind: 'oauth' as const, prefix: '' })),
        ...manual.tokens.map(t => ({ ...t, kind: 'manual' as const })),
      ]);
      setNow(Date.now());
      setError('');
    } catch (e) {
      if (version === refreshVersion.current) setError((e as Error).message);
    } finally {
      if (version === refreshVersion.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => { if (!document.hidden) void refresh(); };
    const timer = setInterval(() => {
      setNow(Date.now());
      if (!document.hidden) void refresh();
    }, 60000);
    window.addEventListener('focus', onFocus);
    return () => {
      refreshVersion.current++;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);
  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      notify('MCP URL copied');
    } catch {
      notify('Could not copy. Select the MCP URL and copy it manually.');
    }
  }
  async function revoke() {
    if (!revoking || revokingBusy) return;
    setRevokingBusy(true);
    setRevokeError('');
    try {
      await api(`/${revoking.kind === 'oauth' ? 'oauth/connections' : 'tokens'}/${revoking.id}`, {
        method: 'DELETE',
      });
      setTokens(current => current.map(token => token.id === revoking.id && token.kind === revoking.kind
        ? { ...token, revoked_at: new Date().toISOString() } : token));
      setRevoking(null);
      notify('Access revoked. Connection moved to Inactive.');
      void refresh();
    } catch (e) {
      setRevokeError((e as Error).message);
    } finally {
      setRevokingBusy(false);
    }
  }
  const connections = tokens.map(token => ({ token, status: connectionStatus(token, mailboxes, now) }))
    .sort((a, b) => new Date(b.token.last_used_at || b.token.created_at).getTime()
      - new Date(a.token.last_used_at || a.token.created_at).getTime());
  const active = connections.filter(item => item.status === 'Active');
  const inactive = connections.filter(item => item.status !== 'Active');
  const search = query.trim().toLowerCase();
  return (
    <div className="section-page agents-page">
      <div className="section-heading">
        <div><h1>Agents</h1><p>Manage who can access your mailboxes.</p></div>
        <Button ref={connectTrigger} onClick={() => setConnecting(true)}>
          <Plus size={16} />Connect agent
        </Button>
      </div>
      <div className="agent-endpoint">
        <Bot size={20} />
        <div><span>MCP server</span><code>{mcpUrl || 'Server URL unavailable'}</code></div>
        <Button variant="outline" size="sm" disabled={!mcpUrl} onClick={() => void copyUrl()}>
          <Copy size={14} />Copy URL
        </Button>
      </div>
      <Tabs value={space} onValueChange={setSpace} className="agent-spaces">
        <div className="agent-toolbar">
          <TabsList variant="line" aria-label="Agent connections">
            <TabsTrigger value="active">Active <span className="agent-count">{loading ? '…' : active.length}</span></TabsTrigger>
            <TabsTrigger value="inactive">Inactive <span className="agent-count">{loading ? '…' : inactive.length}</span></TabsTrigger>
          </TabsList>
          <div className="agent-tools">
            <div className="workspace-search">
              <Search size={15} />
              <Input aria-label="Search connections" placeholder="Search name or mailbox…" value={query} onChange={event => setQuery(event.target.value)} />
              {query && <IconButton label="Clear connection search" onClick={() => setQuery('')}><X size={14} /></IconButton>}
            </div>
            <IconButton label="Refresh connections" disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? <Spinner /> : <RefreshCw size={16} />}
            </IconButton>
          </div>
        </div>
        {error && <div className="agent-error"><ErrorNote message={error} /><Button variant="outline" size="sm" disabled={refreshing} onClick={() => void refresh()}>Try again</Button></div>}
        {(['active', 'inactive'] as const).map(value => {
          const group = value === 'active' ? active : inactive;
          const visible = group.filter(({ token, status }) => `${token.name} ${token.address} ${token.kind} ${status} ${token.scopes.join(' ')}`.toLowerCase().includes(search));
          return <TabsContent value={value} key={value}>
            <p className="agent-space-description">{value === 'active'
              ? 'These connections have mailbox access. Active does not mean an agent is online.'
              : 'Expired, revoked, or unavailable connections. These cannot access a mailbox.'}</p>
            {loading ? <div className="loading-area" role="status"><Spinner /><span>Loading connections…</span></div>
              : error && !tokens.length ? null
              : visible.length ? <div className="agent-list" aria-label={`${value === 'active' ? 'Active' : 'Inactive'} connections`}>
                {visible.map(({ token, status }) => <article className="agent-row" key={`${token.kind}-${token.id}`}>
                  <span className="agent-avatar">{token.kind === 'manual' ? <KeyRound size={18} /> : <Bot size={19} />}</span>
                  <div className="agent-identity">
                    <div className="agent-name"><h2>{token.name}</h2><span className={`status-tag ${status === 'Active' ? 'good' : 'neutral'}`}>{status}</span></div>
                    <p className="agent-address">{token.address}</p>
                    <div className="agent-details">
                      <span>{token.kind === 'oauth' ? 'OAuth' : 'Manual token'}</span>
                      <span title={token.last_used_at ? new Date(token.last_used_at).toLocaleString() : undefined}>
                        {token.last_used_at ? `Last used ${dateLabel(token.last_used_at)}` : 'Not used yet'}
                      </span>
                      <span title={new Date(token.expires_at).toLocaleString()}>
                        {token.revoked_at ? `Revoked ${new Date(token.revoked_at).toLocaleDateString()}`
                          : `${status === 'Expired' ? 'Expired' : 'Expires'} ${new Date(token.expires_at).toLocaleDateString()}`}
                      </span>
                    </div>
                  </div>
                  <div className="scope-tags" aria-label="Permissions">{Array.from(new Set(token.scopes.map(scope => scope === 'send' ? 'write' : scope))).map(scope => <span className="status-tag neutral" key={scope}>{scope.toUpperCase()}</span>)}</div>
                  {!token.revoked_at && status !== 'Expired' && <Button variant="ghost" size="sm" className="agent-revoke" aria-label={`Revoke ${token.name} access to ${token.address}`} onClick={() => {
                    revokeTrigger.current = document.activeElement as HTMLElement;
                    setRevokeError(''); setRevoking(token);
                  }}><Unplug size={14} />Revoke</Button>}
                </article>)}
              </div> : <div className="agent-empty"><Empty
                icon={search ? <Search size={24} /> : <Bot size={26} />}
                title={search ? 'No matching connections' : value === 'active' ? 'No active connections' : 'No inactive connections'}
                description={search ? 'Try another agent name or mailbox address.' : value === 'active' ? 'Connect an agent to give it access to a mailbox you choose.' : 'Connections appear here when access expires or is revoked, or a mailbox becomes inactive.'}
                action={search ? <Button variant="outline" onClick={() => setQuery('')}>Clear search</Button>
                  : value === 'active' ? <Button onClick={() => setConnecting(true)}><Plus size={15} />Connect agent</Button> : undefined}
              /></div>}
          </TabsContent>;
        })}
      </Tabs>
      {connecting && <Modal title="Connect an agent" subtitle="Give an app access to one mailbox and only the permissions it needs." onClose={() => setConnecting(false)}>
        <div className="modal-body agent-setup">
          {!canConnect ? <div className="quiet-note"><Mail size={18} /><span>Create an active mailbox before connecting an agent. <a href="#mailboxes" onClick={() => setConnecting(false)}>Go to Mailboxes</a></span></div> : <>
            <h2>Connect with OAuth</h2>
            <ol><li>In ChatGPT, Codex, or Cursor, add a remote MCP server.</li><li>Paste this URL and choose OAuth authentication.</li><li>Sign in to Mail HQ, then choose a mailbox and permissions.</li></ol>
            <div className="agent-copy-field"><code>{mcpUrl}</code><Button variant="outline" size="sm" disabled={!mcpUrl} onClick={() => void copyUrl()}><Copy size={14} />Copy URL</Button></div>
            <p className="muted">Return here after connecting. Your agent will appear in Active.</p>
            <div className="agent-manual"><h2>Using a script or API token?</h2><p>Create a manual token for apps that need a Bearer token.</p><Button variant="outline" onClick={() => { setConnecting(false); setCreating(true); }}><KeyRound size={15} />Create manual token</Button></div>
          </>}
          <div className="modal-actions"><Button onClick={() => { setConnecting(false); void refresh(); }}>Done</Button></div>
        </div>
      </Modal>}
      {creating && <CreateToken mailboxes={mailboxes} mcpUrl={mcpUrl} onClose={() => {
        setCreating(false);
        void refresh();
        requestAnimationFrame(() => connectTrigger.current?.focus());
      }} />}
      {revoking && <AlertDialog open onOpenChange={open => { if (!open && !revokingBusy) setRevoking(null); }}>
        <AlertDialogContent onCloseAutoFocus={event => {
          event.preventDefault();
          (revokeTrigger.current?.isConnected ? revokeTrigger.current : connectTrigger.current)?.focus();
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking.name}?</AlertDialogTitle>
            <AlertDialogDescription>This agent will lose access to <strong className="break-all">{revoking.address}</strong>. Emails stay in your mailbox. To restore access later, connect the agent again.</AlertDialogDescription>
          </AlertDialogHeader>
          <ErrorNote message={revokeError} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokingBusy}>Keep access</AlertDialogCancel>
            <Button variant="destructive" disabled={revokingBusy} onClick={() => void revoke()}>{revokingBusy && <Spinner />}{revokingBusy ? 'Revoking…' : 'Revoke access'}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>}
    </div>
  );
}
function CreateToken({
  mailboxes,
  mcpUrl,
  onClose,
}: {
  mailboxes: Mailbox[];
  mcpUrl: string;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [box, setBox] = useState(mailboxes.find((b) => b.status === 'active')?.id || '');
  const [read, setRead] = useState(true);
  const [send, setSend] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [days, setDays] = useState(90);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  async function submit() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ token: string }>('/tokens', {
        method: 'POST',
        body: JSON.stringify({
          name,
          mailboxId: box,
          scopes: [...(read ? ['read'] : []), ...(send ? ['write'] : []), ...(admin ? ['admin'] : [])],
          expiresInDays: days,
        }),
      });
      setToken(result.token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const config = JSON.stringify(
    {
      mcpServers: {
        'mail-hq': { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } },
      },
    },
    null,
    2,
  );
  return (
    <Modal
      title={token ? 'Manual token created' : 'Create a manual token'}
      subtitle={
        token
          ? 'Copy this token now. It will only be shown once.'
          : 'Choose a mailbox and the permissions your agent needs.'
      }
      onClose={() => { if (!busy) onClose(); }}
    >
      <div className="modal-body">
        {token ? (
          <>
            <div className="quiet-note">
              <KeyRound size={18} />
              <span>
                Keep this configuration private. It grants access to the selected mailbox.
              </span>
            </div>
            <pre className="config-code" tabIndex={0} aria-label="Agent connection configuration">{config}</pre>
            <ErrorNote message={error} />
            <Button
              className="primary full-width"
              onClick={() => void navigator.clipboard.writeText(config).then(() => { setCopied(true); setError(''); }).catch(() => setError('Could not copy. Select the configuration above and copy it manually.'))}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}{' '}
              {copied ? 'Copied' : 'Copy connection config'}
            </Button>
            <button className="text-button full-width" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="field-label" htmlFor="agent-name">
              Connection name
            </label>
            <Input
              className="input"
              id="agent-name"
              autoFocus
              required
              placeholder="e.g. Research assistant"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
            <label className="field-label" htmlFor="agent-box">
              Mailbox
            </label>
            <Combobox
              id="agent-box"
              label="Agent mailbox"
              searchPlaceholder="Search agent mailboxes…"
              value={box}
              onValueChange={setBox}
              options={mailboxes
                .filter((b) => b.status === 'active')
                .map((b) => ({ value: b.id, label: b.address, description: b.name }))}
            />
            <label className="field-label">Permissions</label>
            <label className="permission-option">
              <Checkbox
                aria-label="Read mail"
                checked={read}
                onCheckedChange={(checked) => setRead(checked === true)}
              />
              <div>
                <strong>READ · Read mail</strong>
                <p>Search messages and download attachments.</p>
              </div>
            </label>
            <label className="permission-option">
              <Checkbox
                aria-label="Send and reply"
                checked={send}
                onCheckedChange={(checked) => setSend(checked === true)}
              />
              <div>
                <strong>WRITE · Send and reply</strong>
                <p>Send messages from this address.</p>
              </div>
            </label>
            <label className="permission-option">
              <Checkbox aria-label="Admin app settings" checked={admin} onCheckedChange={checked => setAdmin(checked === true)} />
              <div><strong>ADMIN · App settings</strong><p>Manage this mailbox’s display settings and saved AI filters. Running filters also needs READ.</p></div>
            </label>
            <label className="field-label" htmlFor="token-expiry">
              Expires after
            </label>
            <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
              <SelectTrigger id="token-expiry" className="w-full" aria-label="Expires after">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[7, 30, 90, 365].map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ErrorNote message={error} />
            <div className="modal-actions">
              <Button variant="outline" type="button" className="secondary" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button className="primary" disabled={busy || !box || (!read && !send && !admin)}>
                {busy ? <Spinner /> : <KeyRound size={16} />}Create connection
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

type Stats = {
  totals: {
    total: number;
    received: number;
    sent: number;
    unread: number;
    failed: number;
    message_bytes: number;
  };
  days: { date: string; received: number; sent: number }[];
  mailboxes: { id: string; address: string; color: string; received: number; sent: number }[];
  storage: { attachments: number; attachment_bytes: number };
  tokens: { active: number };
  activity: { id: string; actor: string; action: string; created_at: string }[];
};
export function Activity() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Stats>('/stats')
      .then(setStats)
      .catch((e) => setError(e.message));
  }, []);
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - 29 + i);
    const date = d.toISOString().slice(0, 10);
    return stats?.days.find((x) => x.date === date) || { date, received: 0, sent: 0 };
  });
  const max = Math.max(1, ...days.map((d) => Math.max(d.received, d.sent)));
  return (
    <div className="section-page">
      <div className="section-heading">
        <div>
          <h1>Statistics</h1>
          <p>Sending, receiving, storage, and billing.</p>
        </div>
      </div>
      <Billing />
      <ErrorNote message={error} />
      {!stats ? (
        <div className="loading-area">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="metric-grid">
            {[
              [ArrowDownLeft, 'Received', stats.totals.received, 'All time'],
              [ArrowUpRight, 'Sent', stats.totals.sent, 'Accepted by Cloudflare'],
              [Mail, 'Unread', stats.totals.unread, 'Across all inboxes'],
              [
                Database,
                'Attachments',
                bytes(stats.storage.attachment_bytes),
                `${stats.storage.attachments} files stored`,
              ],
            ].map(([Icon, label, value, sub]) => {
              const I = Icon as typeof Mail;
              return (
                <div className="metric-card" key={label as string}>
                  <span>
                    {label as string}
                    <I size={17} />
                  </span>
                  <strong>{value as string | number}</strong>
                  <small>{sub as string}</small>
                </div>
              );
            })}
          </div>
          <div className="chart-card">
            <div className="chart-heading">
              <div>
                <h2>Mail over time</h2>
                <p>Last 30 days</p>
              </div>
              <div className="chart-legend">
                <span>
                  <i className="received-dot" />
                  Received
                </span>
                <span>
                  <i className="sent-dot" />
                  Sent
                </span>
              </div>
            </div>
            <div className="chart">
              <div className="chart-guides">
                <span>{max}</span>
                <span>{Math.round(max / 2)}</span>
                <span>0</span>
              </div>
              <div className="chart-bars">
                {days.map((d) => (
                  <div
                    className="bar-group"
                    key={d.date}
                    title={`${d.date}: ${d.received} received, ${d.sent} sent`}
                  >
                    <span
                      className="received-bar"
                      style={{
                        height: `${(d.received / max) * 100}%`,
                        minHeight: d.received ? 3 : 0,
                      }}
                    />
                    <span
                      className="sent-bar"
                      style={{ height: `${(d.sent / max) * 100}%`, minHeight: d.sent ? 3 : 0 }}
                    />
                  </div>
                ))}
              </div>
              {!stats.days.length && (
                <div className="chart-no-data">Your activity will appear as mail arrives.</div>
              )}
            </div>
            <div className="chart-labels">
              <span>{dateLabel(days[0].date)}</span>
              <span>{dateLabel(days[14].date)}</span>
              <span>Today</span>
            </div>
          </div>
          <div className="stats-lower">
            <div className="panel">
              <h2>By mailbox</h2>
              {stats.mailboxes.length ? (
                stats.mailboxes.map((b) => (
                  <div className="stat-mailbox" key={b.id}>
                    <span className="mailbox-dot" style={{ background: b.color }} />
                    <strong>{b.address}</strong>
                    <span>
                      {b.received} in · {b.sent} out
                    </span>
                  </div>
                ))
              ) : (
                <p className="muted">Create a mailbox to start tracking activity.</p>
              )}
            </div>
            <div className="panel">
              <h2>Workspace health</h2>
              <div className="health-row">
                <span>Active agent connections</span>
                <strong>{stats.tokens.active}</strong>
              </div>
              <div className="health-row">
                <span>Failed sends</span>
                <strong className={stats.totals.failed ? 'error-text' : ''}>
                  {stats.totals.failed}
                </strong>
              </div>
              <div className="health-row">
                <span>Stored message content</span>
                <strong>{bytes(stats.totals.message_bytes)}</strong>
              </div>
              <div className="health-row">
                <span>Dashboard protection</span>
                <span className="good-text">
                  <ShieldCheck size={14} /> Cloudflare Access
                </span>
              </div>
            </div>
          </div>
          <div className="panel audit-panel">
            <h2>Recent activity</h2>
            {stats.activity.length ? (
              stats.activity.map((a) => (
                <div className="audit-row" key={a.id}>
                  <span className="audit-dot" />
                  <div>
                    <strong>
                      {(
                        {
                          'mail.received': 'Email received',
                          'mail.sent': 'Email sent to Cloudflare',
                          'mailbox.created': 'Mailbox created',
                          'mailbox.deleted': 'Mailbox deleted',
                          'token.created': 'Agent connected',
                          'token.revoked': 'Agent access revoked',
                          'oauth.authorized': 'App connected with OAuth',
                          'oauth.revoked': 'OAuth access revoked',
                          'settings.provisioning_connected': 'Cloudflare connected',
                        } as Record<string, string>
                      )[a.action] || a.action}
                    </strong>
                    <small>
                      {a.actor.startsWith('agent:') || a.actor.startsWith('oauth:')
                        ? 'Agent'
                        : a.actor === 'email-worker'
                          ? 'Email routing'
                          : a.actor}
                    </small>
                  </div>
                  <time>{dateLabel(a.created_at)}</time>
                </div>
              ))
            ) : (
              <p className="muted">Your workspace activity will appear here.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function Settings({
  data,
  refresh,
  notify,
  onDomainsChange,
}: {
  data: Bootstrap;
  refresh: () => void;
  onDomainsChange: (domains: Domain[]) => void;
  notify: (message: string) => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [domainError, setDomainError] = useState('');
  const [domainStatus, setDomainStatus] = useState('');
  const [domainWarnings, setDomainWarnings] = useState<string[]>([]);
  const [tokenWarnings, setTokenWarnings] = useState<string[]>([]);
  async function connect() {
    setBusy(true);
    setError('');
    setTokenWarnings([]);
    try {
      const result = await api<{ warnings: string[] }>('/settings/cloudflare-token', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      setTokenWarnings(result.warnings);
      setToken('');
      refresh();
      notify(
        result.warnings.length
          ? 'Cloudflare token saved with limited permissions'
          : 'Cloudflare provisioning connected',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sync() {
    if (syncing) return;
    setSyncing(true);
    setDomainError('');
    setDomainStatus('');
    setDomainWarnings([]);
    try {
      const result = await api<{
        domains: Domain[];
        updated: number;
        total: number;
        source: 'dns' | 'cloudflare' | 'mixed';
        receivingChecked: number;
        sendingChecked: number;
        errors: { domain: string; message: string }[];
        warnings: { domain: string; message: string }[];
      }>('/domains/sync', { method: 'POST' });
      onDomainsChange([...result.domains, ...data.domains.filter(d => d.connection_ready !== null && d.connection_ready !== undefined)]);
      if (result.errors.length)
        setDomainError(result.errors.map((issue) => `${issue.domain}: ${issue.message}`).join(' '));
      setDomainWarnings([...new Set(result.warnings.map((issue) => issue.message))]);
      const summary =
        result.updated === result.total
          ? `${result.updated} ${result.updated === 1 ? 'domain' : 'domains'} checked`
          : `${result.updated} of ${result.total} domains checked`;
      setDomainStatus(
        `${summary}. ${result.receivingChecked} receiving checks completed; ${result.sendingChecked ? `${result.sendingChecked} sending checks completed.` : 'sending status was not checked.'}`,
      );
      if (result.updated)
        notify(
          result.errors.length || result.warnings.length
            ? summary
            : result.source === 'dns'
              ? 'Receiving status refreshed'
              : 'Domain status refreshed',
        );
    } catch (e) {
      setDomainError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }
  return (
    <div className="section-page settings-page">
      <div className="section-heading">
        <div>
          <h1>Settings</h1>
          <p>Account and configuration.</p>
        </div>
      </div>
      <div className="panel">
        <h2>Your workspace</h2>
        <div className="settings-row">
          <span>Account</span>
          <strong>{data.identity}</strong>
        </div>
        <div className="settings-row">
          <span>Home</span>
          <strong>{data.appOrigin ? new URL(data.appOrigin).hostname : '—'}</strong>
        </div>
        <div className="settings-row">
          <span>Sign-in</span>
          <span className="good-text">
            <ShieldCheck size={15} /> Cloudflare Access · approved users only
          </span>
        </div>
        <div className="settings-row">
          <span>Attachments &amp; original emails</span>
          <strong>Private Cloudflare R2 storage</strong>
        </div>
      </div>
      {data.ownerConfigured === false && <div className="panel"><p className="muted">The app owner needs to configure OWNER_EMAIL before existing mailboxes can be assigned.</p></div>}
      {data.isAdmin && <div className="panel">
        <h2>Let others use Mail HQ</h2>
        <p className="muted">Add their sign-in emails to this app’s Cloudflare Access policy, then share your app address. Each person gets a private account and can connect their own domains.</p>
        <p className="muted">{data.appOrigin}</p>
        <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer">Manage sign-in access <ArrowUpRight size={14} /></a>
      </div>}
      <PersonalDomains domains={data.domains} refresh={refresh} notify={notify} />
      <MailApps mailboxes={data.mailboxes} notify={notify} />
      {data.isAdmin && <>
      <div className="panel">
        <div className="panel-title">
          <h2>Mailbox provisioning</h2>
          <span className={`status-tag ${data.provisioningConfigured ? 'good' : 'warning'}`}>
            {data.provisioningConfigured ? 'Connected' : 'Optional'}
          </span>
        </div>
        <p className="muted">
          New addresses on managed domains are provisioned instantly. Existing addresses keep their
          original delivery. An optional Cloudflare token lets you refresh domains or add individual
          routing rules.
        </p>
        <details className="setup-help" open={!data.provisioningConfigured}>
          <summary>Cloudflare token permissions</summary>
          <p>
            Create a Cloudflare API token for this account with <strong>Zone · Zone · Read</strong>,{' '}
            <strong>Zone · Zone Settings · Read</strong>, <strong>Zone · DNS · Read</strong>,{' '}
            <strong>Zone · Email Routing Rules · Edit</strong>, and{' '}
            <strong>Email Sending · Read</strong> permissions. Restrict it to the domains you want
            to manage.
          </p>
          <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">
            Create a Cloudflare API token <ArrowUpRight size={14} />
          </a>
        </details>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
          className="token-connect"
        >
          <Input
            className="input"
            type="password"
            autoComplete="off"
            aria-label="Cloudflare API token"
            placeholder={
              data.provisioningConfigured
                ? 'Replace provisioning token'
                : 'Optional Cloudflare API token'
            }
            required
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <Button className="primary" disabled={busy || !token}>
            {busy ? <Spinner /> : <KeyRound size={15} />}Connect
          </Button>
        </form>
        <small className="muted">Stored encrypted. Never shared with email agents.</small>
        <ErrorNote message={error} />
        {tokenWarnings.length > 0 && (
          <div className="domain-notices" role="status">
            {tokenWarnings.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        )}
      </div>
      <div className="panel">
        <div className="panel-title">
          <h2>Domains</h2>
          <Button
            variant="outline"
            className="secondary"
            onClick={() => void sync()}
            disabled={syncing || busy}
          >
            {syncing ? <Spinner /> : <RefreshCw size={14} />}
            {syncing ? 'Refreshing…' : 'Refresh status'}
          </Button>
        </div>
        {!data.provisioningConfigured && (
          <p className="muted">
            Refresh checks receiving DNS. Connect Cloudflare above to also check sending status.
          </p>
        )}
        {domainStatus && (
          <p className="muted" role="status">
            {domainStatus}
          </p>
        )}
        {domainWarnings.length > 0 && (
          <div className="domain-notices" role="status">
            {domainWarnings.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        )}
        <ErrorNote message={domainError} />
        {data.domains.map((d) => (
          <div className="settings-domain" key={d.id}>
            <Globe2 size={18} />
            <div>
              <strong>{d.name}</strong>
              <p>{d.note || 'Available for new mailboxes'}</p>
            </div>
            <span className={`status-tag ${d.receiving ? 'good' : 'neutral'}`}>
              {d.receiving ? 'Ready' : 'Preserved'}
            </span>
          </div>
        ))}
      </div>
      </>}
      <a className="signout-link" href="/cdn-cgi/access/logout">
        Sign out of Mail HQ <ArrowUpRight size={14} />
      </a>
    </div>
  );
}
