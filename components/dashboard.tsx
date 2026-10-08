'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  FileText,
  Inbox,
  Mail,
  MailOpen,
  Menu,
  MoreHorizontal,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SquarePen,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { Activity, Agents, CreateMailbox, Mailboxes, Settings } from './management';
import { Composer } from './composer';
import { Combobox } from './ui/combobox';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Skeleton } from './ui/skeleton';
import {
  api,
  bytes,
  dateLabel,
  Empty,
  ErrorNote,
  escapeHtml,
  IconButton,
  initials,
  sendStatus,
  Spinner,
  type Bootstrap,
  type Draft,
  type Mail as MailData,
} from './shared';

type View =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'starred'
  | 'archive'
  | 'trash'
  | 'spam'
  | 'mailboxes'
  | 'agents'
  | 'activity'
  | 'settings';
const folders = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'drafts', label: 'Drafts', icon: FileText },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'spam', label: 'Spam', icon: ShieldCheck },
  { id: 'trash', label: 'Trash', icon: Trash2 },
] as const;
const emptyData: Bootstrap = {
  mailboxes: [],
  domains: [],
  drafts: [],
  counts: [],
  identity: '',
  provisioningConfigured: false,
  mcpUrl: '',
};
export default function Dashboard() {
  const [data, setData] = useState<Bootstrap>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('inbox');
  const [mailboxId, setMailboxId] = useState('');
  const [messages, setMessages] = useState<MailData[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [unread, setUnread] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<MailData | null>(null);
  const [messageLoading, setMessageLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [createBox, setCreateBox] = useState(false);
  const [compose, setCompose] = useState<{
    reply?: MailData;
    forward?: MailData;
    draft?: Draft;
  } | null>(null);
  const [toast, setToast] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [shortcutHelp, setShortcutHelp] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const isMail = !['mailboxes', 'agents', 'activity', 'settings'].includes(view);
  const notificationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listVersion = useRef(0);
  const notify = useCallback((text: string) => {
    setToast(text);
    if (notificationTimer.current) clearTimeout(notificationTimer.current);
    notificationTimer.current = setTimeout(() => setToast(''), 4500);
  }, []);
  const refresh = useCallback(async () => {
    try {
      setData(await api<Bootstrap>('/bootstrap'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const loadList = useCallback(
    async (cursor?: string) => {
      if (!isMail || view === 'drafts') return;
      const version = ++listVersion.current;
      setListLoading(true);
      const params = new URLSearchParams({ folder: view === 'starred' ? 'inbox' : view });
      if (mailboxId) params.set('mailboxId', mailboxId);
      if (search) params.set('q', search);
      if (unread) params.set('unread', 'true');
      if (view === 'starred') params.set('starred', 'true');
      if (cursor) params.set('cursor', cursor);
      try {
        const result = await api<{ messages: MailData[]; nextCursor: string | null }>(
          `/messages?${params}`,
        );
        if (version !== listVersion.current) return;
        setMessages((old) => (cursor ? [...old, ...result.messages] : result.messages));
        setNextCursor(result.nextCursor);
      } catch (e) {
        if (version === listVersion.current) setError((e as Error).message);
      } finally {
        if (version === listVersion.current) setListLoading(false);
      }
    },
    [isMail, view, mailboxId, search, unread],
  );
  useEffect(() => {
    setSelected(null);
    setMessage(null);
    void loadList();
    const timer = setInterval(() => void loadList(), 30000);
    return () => {
      clearInterval(timer);
      listVersion.current++;
    };
  }, [loadList]);
  useEffect(() => {
    if (!selected) {
      setMessage(null);
      return;
    }
    const controller = new AbortController();
    setMessageLoading(true);
    setMessage(null);
    api<MailData>(`/messages/${selected}`, { signal: controller.signal })
      .then((m) => {
        if (controller.signal.aborted) return;
        setMessage(m);
        if (!m.is_read) {
          void api(`/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ isRead: true }) })
            .then(() => {
              setMessages((old) => old.map((x) => (x.id === m.id ? { ...x, is_read: 1 } : x)));
              void refresh();
            })
            .catch((e) => notify(e.message));
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setMessageLoading(false);
      });
    return () => controller.abort();
  }, [selected, refresh, notify]);
  const openCompose = useCallback(() => {
    if (!data.mailboxes.some((b) => b.status === 'active')) {
      setCreateBox(true);
      return;
    }
    setCompose({});
  }, [data.mailboxes]);
  async function mutate(m: MailData, patch: Record<string, unknown>) {
    try {
      await api(`/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (patch.folder) {
        setSelected(null);
        notify(
          patch.folder === 'trash'
            ? 'Moved to trash'
            : patch.folder === 'archive'
              ? 'Conversation archived'
              : 'Moved to inbox',
        );
      } else {
        setMessage((old) =>
          old?.id === m.id
            ? {
                ...old,
                ...(patch.starred !== undefined ? { starred: +!!patch.starred } : {}),
                ...(patch.isRead !== undefined ? { is_read: +!!patch.isRead } : {}),
              }
            : old,
        );
      }
      await Promise.all([loadList(), refresh()]);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        e.defaultPrevented ||
        target.closest(
          'input,textarea,select,[contenteditable="true"],[role="dialog"],[role="alertdialog"],[role="combobox"],[role="listbox"]',
        )
      )
        return;
      if (e.key === 'c') {
        e.preventDefault();
        openCompose();
      }
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setSelected(null);
        setMobileNav(false);
      }
      if (e.key === '?' || e.key === 'h') setShortcutHelp((x) => !x);
      if ((e.key === 'j' || e.key === 'k') && messages.length) {
        e.preventDefault();
        const i = messages.findIndex((m) => m.id === selected);
        setSelected(
          messages[Math.max(0, Math.min(messages.length - 1, i + (e.key === 'j' ? 1 : -1)))].id,
        );
      }
      if (e.key === 'e' && message) void mutate(message, { folder: 'archive' });
      if (e.key === 'r' && message) setCompose({ reply: message });
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [openCompose, messages, selected, message]);
  const changeView = (next: View) => {
    setView(next);
    setMobileNav(false);
    setSelected(null);
    setQuery('');
    setUnread(false);
  };
  const count = (folder: string) =>
    folder === 'drafts'
      ? data.drafts.length
      : data.counts.find((x) => x.folder === folder)?.unread || 0;
  const title = folders.find((f) => f.id === view)?.label || 'Inbox';
  return (
    <div className="workspace">
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <div className="brand-row">
          <a className="brand" href="/" aria-label="Mail HQ home">
            <Mail size={20} strokeWidth={1.5} />
            Mail HQ
          </a>
          <button
            className="icon-button mobile-nav-close"
            aria-label="Close navigation"
            onClick={() => setMobileNav(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button className="compose-button" onClick={openCompose}>
          <SquarePen size={16} />
          Compose<kbd>C</kbd>
        </button>
        <nav aria-label="Mail folders">
          {folders.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? 'selected' : ''}`}
              aria-current={view === id ? 'page' : undefined}
              onClick={() => changeView(id)}
            >
              <Icon size={18} strokeWidth={1.6} />
              <span>{label}</span>
              {count(id) > 0 && <span className="nav-count">{count(id)}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <nav aria-label="Workspace management">
            {[
              { id: 'mailboxes', label: 'Mailboxes', icon: Mail },
              { id: 'agents', label: 'Agents', icon: Bot },
              { id: 'activity', label: 'Statistics', icon: BarChart3 },
              { id: 'settings', label: 'Settings', icon: Settings2 },
            ].map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={`nav-item ${view === id ? 'selected' : ''}`}
                aria-current={view === id ? 'page' : undefined}
                onClick={() => changeView(id as View)}
              >
                <Icon size={18} strokeWidth={1.6} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="account" title={data.identity}>
            <span className="account-avatar">{initials(data.identity || 'Aditya Baindur')}</span>
            <span>{data.identity || 'Aditya Baindur'}</span>
            <IconButton label="Keyboard shortcuts" onClick={() => setShortcutHelp(!shortcutHelp)}>
              <CircleHelp size={16} />
            </IconButton>
          </div>
        </div>
      </aside>
      {mobileNav && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <main className="main">
        <header className={`topbar ${!isMail ? 'management-topbar' : ''}`}>
          <div className="topbar-title">
            <button
              className="mobile-menu icon-button"
              aria-label="Open navigation"
              aria-expanded={mobileNav}
              onClick={() => setMobileNav(true)}
            >
              <Menu size={19} />
            </button>
            {isMail ? <h1>{title}</h1> : <span>Mail HQ</span>}
          </div>
          {isMail && (
            <div className="topbar-right">
              <Combobox
                className="mailbox-select"
                label="Filter by mailbox"
                searchPlaceholder="Search mailboxes…"
                emptyText="No mailboxes found."
                value={mailboxId}
                onValueChange={(value) => {
                  setMailboxId(value);
                  setSelected(null);
                }}
                options={[
                  { value: '', label: 'All mailboxes' },
                  ...data.mailboxes.map((b) => ({
                    value: b.id,
                    label: b.address,
                    description: b.name,
                  })),
                ]}
              />
              <IconButton
                label="Refresh mail"
                onClick={() => {
                  void refresh();
                  void loadList();
                }}
              >
                {listLoading ? <Spinner /> : <RefreshCw size={16} />}
              </IconButton>
              <button
                className="icon-button mobile-compose"
                aria-label="Compose"
                onClick={openCompose}
              >
                <SquarePen size={18} />
              </button>
            </div>
          )}
        </header>
        {error && (
          <div className="global-error">
            <ErrorNote message={error} />
            <button
              className="text-button"
              onClick={() => {
                void refresh();
                void loadList();
              }}
            >
              Retry
            </button>
            <button className="text-button" onClick={() => window.location.reload()}>
              Refresh session
            </button>
          </div>
        )}
        {loading ? (
          <div className="initial-loading">
            <div className="loading-skeleton" role="status" aria-label="Loading mail">
              <Skeleton className="h-9 w-full" />
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="space-y-3 py-3">
                  <Skeleton className="h-3 w-2/5" />
                  <Skeleton className="h-3 w-4/5" />
                  <Skeleton className="h-3 w-3/5" />
                </div>
              ))}
              <span className="sr-only">Loading mail</span>
            </div>
          </div>
        ) : isMail ? (
          <>
            <div className={`mail-layout ${selected ? 'has-selection' : ''}`}>
              <section className="message-list" aria-label="Message list">
                <div className="search-wrap">
                  <Search size={16} />
                  <Input
                    ref={searchRef}
                    aria-label="Search mail"
                    placeholder="Search mail…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query ? (
                    <IconButton label="Clear search" onClick={() => setQuery('')}>
                      <X size={13} />
                    </IconButton>
                  ) : (
                    <kbd>/</kbd>
                  )}
                </div>
                <div className="list-filters">
                  <div className="segmented">
                    <button className={!unread ? 'active' : ''} onClick={() => setUnread(false)}>
                      All
                    </button>
                    <button className={unread ? 'active' : ''} onClick={() => setUnread(true)}>
                      Unread
                    </button>
                  </div>
                  <span>
                    {view === 'drafts'
                      ? data.drafts.filter((d) => !mailboxId || d.mailbox_id === mailboxId).length
                      : messages.length}
                    {nextCursor ? '+' : ''}
                  </span>
                </div>
                <div className="list-scroll">
                  {view === 'drafts'
                    ? data.drafts
                        .filter(
                          (d) =>
                            (!mailboxId || d.mailbox_id === mailboxId) &&
                            (!search ||
                              `${d.data.subject} ${d.data.to}`
                                .toLowerCase()
                                .includes(search.toLowerCase())),
                        )
                        .map((d) => (
                          <button
                            className="message-row draft-row"
                            key={d.id}
                            onClick={() => setCompose({ draft: d })}
                          >
                            <div className="message-row-top">
                              <strong>
                                <span className="draft-label">Draft</span>{' '}
                                {d.data.to || 'No recipients'}
                              </strong>
                              <time>{dateLabel(d.updated_at)}</time>
                            </div>
                            <h3>{d.data.subject || '(No subject)'}</h3>
                            <p>{d.data.text || 'Continue writing…'}</p>
                          </button>
                        ))
                    : messages.map((m) => (
                        <button
                          className={`message-row ${selected === m.id ? 'selected' : ''} ${!m.is_read ? 'unread' : ''}`}
                          key={m.id}
                          onClick={() => setSelected(m.id)}
                        >
                          <div className="message-row-top">
                            <strong>
                              {!m.is_read && <span className="unread-dot" />}
                              {view === 'sent'
                                ? m.recipients.join(', ')
                                : m.sender_name || m.sender.split('@')[0]}
                            </strong>
                            <time>{dateLabel(m.created_at)}</time>
                          </div>
                          <h3>{m.subject}</h3>
                          <p>{m.snippet}</p>
                          <div className="message-row-bottom">
                            {!mailboxId && data.mailboxes.length > 1 && (
                              <span className="mailbox-pill">
                                {m.mailbox_address ||
                                  data.mailboxes.find((b) => b.id === m.mailbox_id)?.address}
                              </span>
                            )}
                            <span className="message-indicators">
                              {!!m.attachment_count && <Paperclip size={13} />}{' '}
                              {!!m.starred && <Star size={13} fill="currentColor" />}
                              {m.direction === 'outbound' && m.status !== 'accepted' && (
                                <span className={sendStatus(m.status).warning ? 'error-text' : ''}>
                                  {sendStatus(m.status).label}
                                </span>
                              )}
                            </span>
                          </div>
                        </button>
                      ))}
                  {((view === 'drafts' && !data.drafts.length) ||
                    (view !== 'drafts' && !messages.length)) &&
                    !listLoading && (
                      <div className="list-empty">
                        <Inbox size={28} strokeWidth={1.1} />
                        <strong>
                          {search ? 'No matches' : unread ? 'No unread messages' : 'No messages'}
                        </strong>
                        <p>
                          {search
                            ? 'Try a different name or subject.'
                            : view === 'drafts'
                              ? 'Your drafts will be saved here.'
                              : data.mailboxes.length
                                ? 'New conversations will appear here.'
                                : 'Create a mailbox to receive email.'}
                        </p>
                      </div>
                    )}
                  {listLoading && !messages.length && (
                    <div className="loading-area">
                      <Spinner />
                    </div>
                  )}
                  {nextCursor && (
                    <button
                      className="load-more"
                      disabled={listLoading}
                      onClick={() => void loadList(nextCursor)}
                    >
                      {listLoading ? <Spinner /> : 'Load more messages'}
                    </button>
                  )}
                </div>
              </section>
              <section className="reading-pane" aria-label="Message content">
                {messageLoading ? (
                  <div className="loading-area">
                    <Spinner />
                  </div>
                ) : message ? (
                  <MessageReader
                    message={message}
                    onBack={() => setSelected(null)}
                    onReply={() => setCompose({ reply: message })}
                    onForward={() => setCompose({ forward: message })}
                    onMutate={(patch) => void mutate(message, patch)}
                    onOpen={setSelected}
                  />
                ) : (
                  <div className="reading-empty">
                    <Empty
                      title={
                        !data.mailboxes.length
                          ? 'Create your first mailbox'
                          : messages.length
                            ? 'Select a message'
                            : 'No message selected'
                      }
                      description={
                        !data.mailboxes.length
                          ? 'Add an email address to get started.'
                          : messages.length
                            ? 'Choose a message to read or reply.'
                            : 'Your messages will appear here.'
                      }
                      action={
                        !data.mailboxes.length ? (
                          <Button className="primary" onClick={() => setCreateBox(true)}>
                            <Plus size={16} />
                            Create a mailbox
                          </Button>
                        ) : undefined
                      }
                    />
                  </div>
                )}
              </section>
            </div>
          </>
        ) : view === 'mailboxes' ? (
          <Mailboxes
            data={data}
            onCreate={() => setCreateBox(true)}
            onOpen={(id) => {
              setMailboxId(id);
              changeView('inbox');
            }}
          />
        ) : view === 'agents' ? (
          <Agents mailboxes={data.mailboxes} mcpUrl={data.mcpUrl} notify={notify} />
        ) : view === 'activity' ? (
          <Activity />
        ) : (
          <Settings data={data} refresh={() => void refresh()} notify={notify} />
        )}
      </main>
      {createBox && (
        <CreateMailbox
          domains={data.domains}
          onClose={() => setCreateBox(false)}
          onCreated={() => {
            setCreateBox(false);
            void refresh();
            notify('Your new mailbox is ready');
          }}
        />
      )}
      {compose && (
        <Composer
          key={compose.draft?.id || compose.reply?.id || compose.forward?.id || 'new'}
          mailboxes={data.mailboxes}
          initialMailbox={mailboxId}
          {...compose}
          onClose={() => {
            setCompose(null);
            void refresh();
          }}
          onSent={() => {
            setCompose(null);
            notify('Message sent to Cloudflare');
            void refresh();
            void loadList();
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {shortcutHelp && (
        <div className="shortcut-popover">
          <div>
            <strong>Keyboard shortcuts</strong>
            <IconButton label="Close shortcuts" onClick={() => setShortcutHelp(false)}>
              <X size={14} />
            </IconButton>
          </div>
          {[
            ['C', 'New message'],
            ['/', 'Search mail'],
            ['J / K', 'Next / previous message'],
            ['R', 'Reply'],
            ['E', 'Archive'],
            ['Esc', 'Back to inbox'],
          ].map(([k, label]) => (
            <p key={k}>
              <span>{label}</span>
              <kbd>{k}</kbd>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageReader({
  message: m,
  onBack,
  onReply,
  onForward,
  onMutate,
  onOpen,
}: {
  message: MailData;
  onBack: () => void;
  onReply: () => void;
  onForward: () => void;
  onMutate: (patch: Record<string, unknown>) => void;
  onOpen: (id: string) => void;
}) {
  const [showHtml, setShowHtml] = useState(true);
  const [thread, setThread] = useState<MailData[]>([]);
  const [details, setDetails] = useState(false);
  const sending = m.direction === 'outbound' ? sendStatus(m.status) : null;
  useEffect(() => {
    setShowHtml(true);
    setDetails(false);
    api<{ messages: MailData[] }>(`/messages/${m.id}/thread`)
      .then((d) => setThread(d.messages))
      .catch(() => setThread([]));
  }, [m.id]);
  const safeDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'; script-src 'none'"><style>body{font:14px/1.75 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#171717;margin:0;padding:0;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#0070f3}blockquote{margin-left:0;padding-left:16px;border-left:2px solid #ddd;color:#777}</style></head><body>${m.html || escapeHtml(m.text || '').replace(/\n/g, '<br>')}</body></html>`;
  return (
    <>
      <div className="reader-toolbar">
        <div>
          <IconButton label="Back to message list" onClick={onBack}>
            <ArrowLeft size={17} />
          </IconButton>
          <span className="toolbar-divider" />
          <IconButton
            label={m.folder === 'archive' ? 'Move to inbox' : 'Archive message'}
            onClick={() => onMutate({ folder: m.folder === 'archive' ? 'inbox' : 'archive' })}
          >
            <Archive size={17} />
          </IconButton>
          <IconButton label="Move to trash" onClick={() => onMutate({ folder: 'trash' })}>
            <Trash2 size={17} />
          </IconButton>
          <IconButton label="Mark unread" onClick={() => onMutate({ isRead: false })}>
            <Mail size={17} />
          </IconButton>
        </div>
        <div>
          <IconButton
            label={m.starred ? 'Remove star' : 'Star message'}
            active={!!m.starred}
            onClick={() => onMutate({ starred: !m.starred })}
          >
            <Star size={17} fill={m.starred ? 'currentColor' : 'none'} />
          </IconButton>
          {m.hasRaw && (
            <a
              className="icon-button"
              title="Download original email"
              aria-label="Download original email"
              href={`/api/messages/${m.id}/raw`}
            >
              <ArrowDownIcon />
            </a>
          )}
        </div>
      </div>
      <div className="reader-scroll">
        <div className="message-heading">
          <h2>{m.subject}</h2>
          {sending && (
            <span className={`status-tag ${sending.warning ? 'warning' : 'neutral'}`}>
              {sending.label}
            </span>
          )}
        </div>
        {thread.length > 1 && (
          <div className="thread-strip">
            {thread
              .filter((x) => x.id !== m.id)
              .map((x) => (
                <button key={x.id} onClick={() => onOpen(x.id)}>
                  <Reply size={13} />
                  <strong>{x.sender_name || x.sender}</strong>
                  <span>{x.snippet.slice(0, 60)}</span>
                  <time>{dateLabel(x.created_at)}</time>
                </button>
              ))}
          </div>
        )}
        <div className="sender-line">
          <div>
            <strong>{m.sender_name || m.sender}</strong>
            <button
              className="recipient-details"
              aria-expanded={details}
              onClick={() => setDetails(!details)}
            >
              to {m.recipients.join(', ')} <ChevronDown size={12} />
            </button>
          </div>
          <time title={new Date(m.created_at).toLocaleString()}>
            {new Date(m.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
            <span>
              {new Date(m.created_at).toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
          </time>
        </div>
        {details && (
          <div className="message-details">
            {sending && (
              <details className="delivery-details" key={m.id}>
                <summary>About this status</summary>
                <p>{sending.detail}</p>
                {m.status === 'accepted' && (
                  <p>
                    Even a provider's “delivered” status means the recipient's mail server accepted
                    it. The recipient's provider decides whether it appears in Inbox or Spam.
                  </p>
                )}
              </details>
            )}
            <p>
              <strong>From</strong> {m.sender}
            </p>
            <p>
              <strong>To</strong> {m.recipients.join(', ')}
            </p>
            {m.cc.length > 0 && (
              <p>
                <strong>Cc</strong> {m.cc.join(', ')}
              </p>
            )}
            {m.bcc.length > 0 && (
              <p>
                <strong>Bcc</strong> {m.bcc.join(', ')}
              </p>
            )}
            <p>
              <strong>Date</strong> {new Date(m.created_at).toLocaleString()}
            </p>
            {m.message_id && (
              <p>
                <strong>Message ID</strong> {m.message_id}
              </p>
            )}
          </div>
        )}
        {m.error && <ErrorNote message={m.error} />}
        <div className="body-format">
          <span>
            <ShieldCheck size={12} />
            External images blocked
          </span>
          {m.html && (
            <button className="text-button" onClick={() => setShowHtml(!showHtml)}>
              {showHtml ? 'Plain text' : 'Formatted'}
            </button>
          )}
        </div>
        {m.html && showHtml ? (
          <iframe
            title="Email body"
            className="email-frame"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={safeDoc}
          />
        ) : (
          <div className="email-text">{m.text || m.snippet}</div>
        )}
        {!!m.attachments?.length && (
          <div className="attachment-section">
            <h3>
              <Paperclip size={14} />
              {m.attachments.length} attachment{m.attachments.length !== 1 ? 's' : ''}
            </h3>
            <div className="attachment-grid">
              {m.attachments.map((a) => (
                <a key={a.id} className="attachment" href={`/api/attachments/${a.id}`} download>
                  <span>
                    <FileText size={21} />
                  </span>
                  <div>
                    <strong>{a.filename}</strong>
                    <small>{bytes(a.size)}</small>
                  </div>
                  <ArrowDownIcon />
                </a>
              ))}
            </div>
          </div>
        )}
        <div className="reply-actions">
          <Button variant="outline" className="secondary" onClick={onReply}>
            <Reply size={16} />
            Reply
          </Button>
          <button className="text-button" onClick={onForward}>
            <ArrowRight size={16} />
            Forward
          </button>
        </div>
      </div>
    </>
  );
}
function ArrowDownIcon() {
  return (
    <svg
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4" />
    </svg>
  );
}
