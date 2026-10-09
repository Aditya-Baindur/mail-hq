'use client';
import { defaultFilter } from 'cmdk';
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Archive,
  ArrowDown,
  BarChart3,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  FileText,
  Inbox,
  Mail,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  Plus,
  RefreshCw,
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
import { MessageReader } from './message-reader';
import { SenderAvatar } from './sender-avatar';
import { HighlightedText } from './search-highlight';
import { Combobox } from './ui/combobox';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Skeleton } from './ui/skeleton';
import { Avatar, AvatarFallback } from './ui/avatar';
import { Badge } from './ui/badge';
import { Checkbox } from './ui/checkbox';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { Kbd } from './ui/kbd';
import { Separator } from './ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from './ui/sidebar';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from './ui/command';
import {
  api,
  dateLabel,
  Empty,
  ErrorNote,
  IconButton,
  initials,
  Modal,
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

function messageDateGroup(value: string) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], {
    month: 'long',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}
const workspaceViews = [
  { id: 'mailboxes', label: 'Mailboxes', icon: Mail },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'activity', label: 'Statistics', icon: BarChart3 },
  { id: 'settings', label: 'Settings', icon: Settings2 },
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
type Page = { messages: MailData[]; nextCursor: string | null; total: number };
type Notice = { text: string; undo?: () => void };

export default function Dashboard() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('mailhq-sidebar');
      setSidebarOpen(saved ? saved !== 'collapsed' : window.matchMedia('(min-width: 1100px)').matches);
    } catch {}
  }, []);
  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={(open) => {
        setSidebarOpen(open);
        try {
          localStorage.setItem('mailhq-sidebar', open ? 'expanded' : 'collapsed');
        } catch {}
      }}
      className="mail-workspace"
      style={{ '--sidebar-width': '224px', '--sidebar-width-icon': '56px' } as CSSProperties}
    >
      <MailWorkspace />
    </SidebarProvider>
  );
}

function MailWorkspace() {
  const { setOpenMobile, toggleSidebar, isMobile } = useSidebar();
  const [data, setData] = useState<Bootstrap>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [view, setView] = useState<View>('inbox');
  const [mailboxId, setMailboxId] = useState('');
  const [messages, setMessages] = useState<MailData[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [unread, setUnread] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<MailData | null>(null);
  const [messageLoading, setMessageLoading] = useState(false);
  const [messageError, setMessageError] = useState('');
  const [messageVersion, setMessageVersion] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [createBox, setCreateBox] = useState(false);
  const [compose, setCompose] = useState<{
    reply?: MailData;
    forward?: MailData;
    draft?: Draft;
  } | null>(null);
  const [toast, setToast] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [shortcutHelp, setShortcutHelp] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listVersion = useRef(0);
  const pagesLoaded = useRef(1);
  const firstLoad = useRef(true);
  const lastOpened = useRef<string | null>(null);
  const isMail = !workspaceViews.some((item) => item.id === view);
  const isSearching = isMail && !!search;
  const showingDrafts = view === 'drafts' && !isSearching;
  const title = [...folders, ...workspaceViews].find((f) => f.id === view)?.label || 'Inbox';
  const activeBox = data.mailboxes.find((box) => box.id === mailboxId);
  const notify = useCallback((text: string, undo?: () => void) => setToast({ text, undo }), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.undo ? 9000 : 5000);
    return () => clearTimeout(timer);
  }, [toast]);
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
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const loadList = useCallback(
    async (cursor?: string) => {
      if (!isMail || showingDrafts) {
        setListLoading(false);
        return;
      }
      const version = ++listVersion.current;
      setListLoading(true);
      const params = new URLSearchParams({
        folder: isSearching ? 'all' : view === 'starred' ? 'inbox' : view,
      });
      if (mailboxId && !isSearching) params.set('mailboxId', mailboxId);
      if (search) params.set('q', search);
      if (unread && !isSearching) params.set('unread', 'true');
      if (view === 'starred' && !isSearching) params.set('starred', 'true');
      if (cursor) params.set('cursor', cursor);
      try {
        let result = await api<Page>(`/messages?${params}`);
        const loaded = [...result.messages];
        // Refresh every already-loaded page so polling never truncates the inbox.
        let fetched = 1;
        while (!cursor && fetched < pagesLoaded.current && result.nextCursor) {
          params.set('cursor', result.nextCursor);
          result = await api<Page>(`/messages?${params}`);
          loaded.push(...result.messages);
          fetched++;
          if (version !== listVersion.current) return;
        }
        if (version !== listVersion.current) return;
        if (cursor) pagesLoaded.current++;
        else pagesLoaded.current = fetched;
        setMessages((old) =>
          cursor ? [...old, ...loaded.filter((m) => !old.some((x) => x.id === m.id))] : loaded,
        );
        setTotal(result.total);
        setNextCursor(result.nextCursor);
        setListError('');
        firstLoad.current = false;
        return loaded[0]?.id;
      } catch (e) {
        if (version === listVersion.current) setListError((e as Error).message);
      } finally {
        if (version === listVersion.current) setListLoading(false);
      }
    },
    [isMail, view, mailboxId, search, unread, isSearching, showingDrafts],
  );
  const latestListLoader = useRef(loadList);
  latestListLoader.current = loadList;
  useEffect(() => {
    pagesLoaded.current = 1;
    firstLoad.current = true;
    setMessages([]);
    setTotal(null);
    setNextCursor(null);
    setChecked(new Set());
    setSelected(null);
    setListError('');
    void loadList();
    const timer = setInterval(() => {
      if (!document.hidden) void loadList();
    }, 30000);
    return () => {
      clearInterval(timer);
      listVersion.current++;
    };
  }, [loadList]);
  useEffect(() => {
    if (!selected) {
      setMessage(null);
      setMessageLoading(false);
      return;
    }
    const controller = new AbortController();
    setMessageLoading(true);
    setMessage(null);
    setMessageError('');
    api<MailData>(`/messages/${selected}`, { signal: controller.signal })
      .then(async (m) => {
        if (controller.signal.aborted) return;
        setMessage(m);
        if (!m.is_read) {
          try {
            await api(`/messages/${m.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ isRead: true }),
            });
            if (controller.signal.aborted) return;
            setMessage({ ...m, is_read: 1 });
            setMessages((old) => old.map((x) => (x.id === m.id ? { ...x, is_read: 1 } : x)));
            void refresh();
          } catch (e) {
            notify((e as Error).message);
          }
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setMessageError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setMessageLoading(false);
      });
    return () => controller.abort();
  }, [selected, messageVersion, refresh, notify]);
  const openCompose = useCallback(() => {
    if (!data.mailboxes.some((b) => b.status === 'active')) setCreateBox(true);
    else setCompose({});
    setOpenMobile(false);
  }, [data.mailboxes, setOpenMobile]);
  const changeView = (next: View) => {
    setView(next);
    setOpenMobile(false);
    setSelected(null);
    setQuery('');
    setSearch('');
    setUnread(false);
    setChecked(new Set());
  };
  const openMessage = (id: string) => {
    lastOpened.current = id;
    setSelected(id);
  };
  useEffect(() => {
    if (!selected || isMobile) return;
    const row = listRef.current?.querySelector<HTMLButtonElement>(`[data-message-id="${selected}"]`);
    const list = listRef.current;
    if (!row || !list) return;
    const bounds = row.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    // Keep keyboard/toolbar navigation visible without moving the other pane.
    if (bounds.top < viewport.top) list.scrollTop -= viewport.top - bounds.top;
    else if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom;
  }, [selected, isMobile]);
  const backToList = () => {
    setSelected(null);
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-message-id="${lastOpened.current}"]`)
        ?.focus(),
    );
  };
  async function mutateMany(items: MailData[], patch: Record<string, unknown>) {
    if (busy || !items.length) return;
    setBusy(true);
    const results = await Promise.allSettled(
      items.map((m) => api(`/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify(patch) })),
    );
    const succeeded = items.filter((_, i) => results[i].status === 'fulfilled');
    const successIds = new Set(succeeded.map((m) => m.id));
    if (selected && successIds.has(selected)) {
      if (
        (patch.folder && !isSearching) ||
        patch.isRead === false ||
        (!isSearching && view === 'starred' && patch.starred === false)
      ) {
        const i = messages.findIndex((m) => m.id === selected);
        const next =
          messages.slice(i + 1).find((m) => !successIds.has(m.id)) ||
          messages
            .slice(0, i)
            .reverse()
            .find((m) => !successIds.has(m.id));
        setSelected((current) =>
          current === selected ? (patch.isRead === false ? null : next?.id || null) : current,
        );
      } else
        setMessage((m) =>
          m && successIds.has(m.id)
            ? {
                ...m,
                ...(typeof patch.folder === 'string' ? { folder: patch.folder } : {}),
                ...(patch.starred !== undefined ? { starred: +!!patch.starred } : {}),
                ...(patch.isRead !== undefined ? { is_read: +!!patch.isRead } : {}),
              }
            : m,
        );
    }
    setChecked((old) => new Set([...old].filter((id) => !successIds.has(id))));
    await Promise.all([latestListLoader.current(), refresh()]);
    setBusy(false);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed?.status === 'rejected') {
      notify(
        `${succeeded.length ? `${succeeded.length} updated. ` : ''}${failed.reason instanceof Error ? failed.reason.message : 'Some messages could not be updated. Please retry.'}`,
      );
      return;
    }
    const label =
      patch.folder === 'trash'
        ? 'Moved to trash'
        : patch.folder === 'archive'
          ? 'Archived'
          : patch.folder
            ? `Moved to ${patch.folder}`
            : patch.isRead === false
              ? 'Marked as unread'
              : patch.isRead === true
                ? 'Marked as read'
                : patch.starred
                  ? 'Starred'
                  : 'Star removed';
    notify(
      `${label}${items.length > 1 ? ` · ${items.length} messages` : ''}`,
      patch.folder
        ? () => {
            void (async () => {
              try {
                await Promise.all(
                  succeeded.map((m) =>
                    api(`/messages/${m.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ folder: m.folder }),
                    }),
                  ),
                );
                await Promise.all([latestListLoader.current(), refresh()]);
                notify('Change undone');
              } catch (e) {
                notify((e as Error).message);
              }
            })();
          }
        : undefined,
    );
  }
  const mutate = (m: MailData, patch: Record<string, unknown>) => void mutateMany([m], patch);
  const navigateMessage = (direction: 1 | -1) => {
    if (busy || !messages.length) return;
    const index = messages.findIndex((m) => m.id === selected);
    if (direction === 1 && index === messages.length - 1 && nextCursor) {
      if (!listLoading)
        void loadList(nextCursor).then((id) => {
          if (id) openMessage(id);
        });
    } else openMessage(messages[Math.max(0, Math.min(messages.length - 1, index + direction))].id);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.defaultPrevented || e.isComposing || compose || createBox || shortcutHelp) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandQuery('');
        setCommandOpen((open) => !open);
        return;
      }
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        commandOpen ||
        target.closest(
          'input,textarea,select,[contenteditable="true"],[role="dialog"],[role="alertdialog"],[role="combobox"],[role="listbox"],[role="menu"]',
        )
      )
        return;
      if (e.key === '/') {
        e.preventDefault();
        setCommandQuery('');
        setCommandOpen(true);
      }
      if (e.key === 'c') {
        e.preventDefault();
        openCompose();
      }
      if (e.key === 'Escape') {
        backToList();
        setOpenMobile(false);
        setChecked(new Set());
      }
      if (e.key === '?') {
        e.preventDefault();
        setShortcutHelp(true);
      }
      if ((e.key === 'j' || e.key === 'k') && messages.length && isMail) {
        e.preventDefault();
        navigateMessage(e.key === 'j' ? 1 : -1);
      }
      if (!busy && message) {
        if (e.key === 'e') mutate(message, { folder: 'archive' });
        if (e.key === 'r') setCompose({ reply: message });
        if (e.key === 'f') setCompose({ forward: message });
        if (e.key === 's') mutate(message, { starred: !message.starred });
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  });
  const folderCount = (folder: string) =>
    folder === 'drafts'
      ? data.drafts.filter((d) => !mailboxId || d.mailbox_id === mailboxId).length
      : data.counts
          .filter((x) => x.folder === folder && (!mailboxId || x.mailbox_id === mailboxId))
          .reduce((n, x) => n + x.count, 0);
  const drafts = data.drafts.filter(
    (d) =>
      (!mailboxId || d.mailbox_id === mailboxId) &&
      (!search ||
        `${d.data.subject} ${d.data.to} ${d.data.text}`
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  const totalCount = showingDrafts ? drafts.length : total;
  const selectionIndex = messages.findIndex((m) => m.id === selected);
  const checkedMessages = messages.filter((m) => checked.has(m.id));
  const allChecked = messages.length > 0 && checkedMessages.length === messages.length;
  const runCommand = (action: () => void) => {
    setCommandOpen(false);
    setCommandQuery('');
    action();
  };
  const refreshAll = () => {
    void refresh();
    void loadList();
  };
  return (
    <>
      <Sidebar collapsible="icon" className="mail-sidebar">
        <SidebarHeader className="mail-sidebar-header">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                className="mail-brand"
                tooltip="Mail HQ"
                onClick={() => changeView('inbox')}
              >
                <span className="mail-brand-mark"><Mail size={19} strokeWidth={1.7} /></span>
                <span className="brand-copy">Mail<span>HQ</span></span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <div className="mailbox-switcher">
            <Combobox
              label="Switch mailbox"
              value={mailboxId}
              onValueChange={(id) => {
                setMailboxId(id);
                setSelected(null);
                setOpenMobile(false);
              }}
              searchPlaceholder="Find a mailbox…"
              options={[
                {
                  value: '',
                  label: 'All mailboxes',
                  description: `${data.mailboxes.length} connected addresses`,
                },
                ...data.mailboxes.map((b) => ({
                  value: b.id,
                  label: b.address,
                  description: b.name,
                })),
              ]}
            />
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton className="sidebar-compose" tooltip="Compose · C" onClick={openCompose}>
                <SquarePen />
                <span>Compose</span>
                <Kbd className="ml-auto">C</Kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Mailbox</SidebarGroupLabel>
            <SidebarMenu>
              {folders.map(({ id, label, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    tooltip={`${label} · ${folderCount(id).toLocaleString()}`}
                    isActive={view === id}
                    aria-current={view === id ? 'page' : undefined}
                    onClick={() => changeView(id)}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge aria-label={`${folderCount(id)} messages`}>
                    {loading ? '—' : folderCount(id).toLocaleString()}
                  </SidebarMenuBadge>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup className="mt-auto">
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarMenu>
              {workspaceViews.map(({ id, label, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    tooltip={label}
                    isActive={view === id}
                    onClick={() => changeView(id)}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="mail-sidebar-footer">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Commands · /"
                onClick={() => {
                  setCommandQuery('');
                  setCommandOpen(true);
                }}
              >
                <Search />
                <span>Commands</span>
                <Kbd className="ml-auto">/</Kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <Separator />
          <div className="mail-account">
            <Avatar className="size-8">
              <AvatarFallback>{initials(data.identity || 'You')}</AvatarFallback>
            </Avatar>
            <div>
              <strong>{data.identity.split('@')[0] || 'Your account'}</strong>
              <span>{data.identity || 'Mail HQ'}</span>
            </div>
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="mail-main">
        <header className="mail-topbar">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <Separator orientation="vertical" className="h-5!" />
          <span className="mail-breadcrumb">
            {isSearching ? 'All mailboxes' : activeBox?.name || 'All mailboxes'}
          </span>
          <span className="mail-breadcrumb-divider">/</span>
          <span className="mail-location">{isSearching ? 'Search results' : title}</span>
          <div className="mail-topbar-actions">
            <Button
              variant="ghost"
              size="sm"
              className="command-launcher"
              onClick={() => {
                setCommandQuery('');
                setCommandOpen(true);
              }}
            >
              <Search size={15} />
              <span>Commands</span>
              <Kbd>/</Kbd>
            </Button>
            <IconButton label="Keyboard shortcuts" onClick={() => setShortcutHelp(true)}>
              <CircleHelp size={17} />
            </IconButton>
          </div>
        </header>
        {error && (
          <div className="global-error">
            <ErrorNote message={error} />
            <Button variant="outline" size="sm" onClick={refreshAll}>
              Retry
            </Button>
          </div>
        )}
        {loading ? (
          <MailSkeleton />
        ) : isMail ? (
          <div className="mail-content" data-message-open={!!selected}>
            <section className="inbox-surface" aria-label="Message list" hidden={isMobile && !!selected}>
              <div className="inbox-heading">
                <div>
                  <h1>
                    {isSearching ? 'Search results' : title}
                    <span className="total-badge" aria-label={`${totalCount ?? 0} messages`}>
                      {totalCount === null ? '…' : totalCount.toLocaleString()}
                    </span>
                  </h1>
                  <p className="inbox-subtitle">
                    {isSearching ? 'Across all mailboxes and folders' : activeBox?.address || 'All mailboxes'}
                  </p>
                </div>
                <Button onClick={openCompose} size="icon" aria-label="New message" title="New message">
                  <SquarePen size={16} />
                </Button>
              </div>
              <div className="inbox-search">
                <Search size={18} />
                <Input
                  ref={searchRef}
                  aria-label="Search mail"
                  placeholder="Search all mail"
                  maxLength={200}
                  value={query}
                  onChange={(e) => {
                    if (e.target.value.startsWith('/')) {
                      setCommandQuery(e.target.value.slice(1));
                      setCommandOpen(true);
                      return;
                    }
                    setQuery(e.target.value);
                  }}
                />
                {query ? (
                  <IconButton label="Clear search" onClick={() => setQuery('')}>
                    <X size={16} />
                  </IconButton>
                ) : (
                  <Kbd>/</Kbd>
                )}
              </div>
              <div className="inbox-controls">
                <div className="inbox-control-group">
                  {!showingDrafts && (
                    <Checkbox
                      aria-label="Select all loaded messages"
                      checked={allChecked ? true : checkedMessages.length ? 'indeterminate' : false}
                      onCheckedChange={(value) =>
                        setChecked(value ? new Set(messages.map((m) => m.id)) : new Set())
                      }
                      disabled={!messages.length || busy}
                    />
                  )}
                  {checkedMessages.length ? (
                    <>
                      <span className="selection-count">{checkedMessages.length} selected</span>
                      <IconButton
                        label="Archive selected"
                        disabled={busy}
                        onClick={() => void mutateMany(checkedMessages, { folder: 'archive' })}
                      >
                        <Archive size={16} />
                      </IconButton>
                      <IconButton
                        label="Mark selected as read"
                        disabled={busy}
                        onClick={() => void mutateMany(checkedMessages, { isRead: true })}
                      >
                        <CheckCheck size={16} />
                      </IconButton>
                      <IconButton
                        label="Trash selected"
                        disabled={busy}
                        onClick={() => void mutateMany(checkedMessages, { folder: 'trash' })}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                      <Button variant="ghost" size="sm" onClick={() => setChecked(new Set())}>
                        Clear
                      </Button>
                    </>
                  ) : isSearching ? (
                    <span
                      className="mail-search-scope"
                      title="Searches full message text, subjects and addresses in Inbox, Sent, Archive, Spam and Trash."
                    >
                      All mailboxes · All folders
                    </span>
                  ) : !showingDrafts ? (
                    <Tabs
                      value={unread ? 'unread' : 'all'}
                      onValueChange={(v) => setUnread(v === 'unread')}
                    >
                      <TabsList>
                        <TabsTrigger value="all">All mail</TabsTrigger>
                        <TabsTrigger value="unread">Unread</TabsTrigger>
                      </TabsList>
                    </Tabs>
                  ) : (
                    <span className="selection-count">Saved drafts</span>
                  )}
                </div>
                <div className="inbox-control-group">
                  <span className="mail-result-count" role="status">
                    {totalCount === null
                      ? 'Loading…'
                      : `${totalCount.toLocaleString()} ${totalCount === 1 ? 'message' : 'messages'}`}
                  </span>
                  <IconButton label="Refresh mail" disabled={listLoading} onClick={refreshAll}>
                    {listLoading ? <Spinner /> : <RefreshCw size={15} />}
                  </IconButton>
                </div>
              </div>
              {listError && (
                <div className="mail-list-error">
                  <ErrorNote message={listError} />
                  <Button variant="outline" onClick={() => void loadList()}>
                    Try again
                  </Button>
                </div>
              )}
              <div className="inbox-list" ref={listRef} aria-busy={listLoading}>
                {listLoading && firstLoad.current && !showingDrafts ? (
                  <MailSkeleton />
                ) : showingDrafts ? (
                  drafts.map((d) => (
                    <Button
                      variant="ghost"
                      className="mail-draft-row"
                      key={d.id}
                      onClick={() => setCompose({ draft: d })}
                    >
                      <Badge variant="outline">Draft</Badge>
                      <span>
                        <strong>{d.data.subject || 'Untitled message'}</strong>
                        <small>
                          {d.data.to || 'No recipients yet'} · {d.data.text || 'Continue writing…'}
                        </small>
                      </span>
                      <time>{dateLabel(d.updated_at)}</time>
                    </Button>
                  ))
                ) : (
                  messages.map((m, index) => (
                    <Fragment key={m.id}>
                    {(index === 0 || messageDateGroup(messages[index - 1].created_at) !== messageDateGroup(m.created_at)) && (
                      <div className="mail-date-group">{messageDateGroup(m.created_at)}</div>
                    )}
                    <div
                      className={`inbox-row ${!m.is_read ? 'is-unread' : ''} ${checked.has(m.id) ? 'is-checked' : ''} ${selected === m.id ? 'is-selected' : ''}`}
                      key={m.id}
                    >
                      <Checkbox
                        className="row-check"
                        aria-label={`Select ${m.subject || 'Untitled message'}`}
                        checked={checked.has(m.id)}
                        disabled={busy}
                        onCheckedChange={(value) =>
                          setChecked((old) => {
                            const next = new Set(old);
                            if (value) next.add(m.id);
                            else next.delete(m.id);
                            return next;
                          })
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className={`row-star ${m.starred ? 'is-starred' : ''}`}
                        aria-label={`${m.starred ? 'Unstar' : 'Star'} ${m.subject}`}
                        disabled={busy}
                        onClick={() => mutate(m, { starred: !m.starred })}
                      >
                        <Star size={15} fill={m.starred ? 'currentColor' : 'none'} />
                      </Button>
                      <button
                        className="mail-row-open"
                        data-message-id={m.id}
                        aria-current={selected === m.id ? 'true' : undefined}
                        aria-controls="mail-reading-pane"
                        onClick={() => openMessage(m.id)}
                      >
                        <SenderAvatar
                          className="row-avatar"
                          name={m.folder === 'sent' ? undefined : m.sender_name}
                          address={m.folder === 'sent' ? m.recipients[0] || m.sender : m.sender}
                        />
                        <span className="row-sender">
                          <span>
                            <HighlightedText
                              query={search}
                              text={
                                m.folder === 'sent'
                                  ? m.recipients.join(', ')
                                  : m.sender_name || m.sender.split('@')[0]
                              }
                            />
                          </span>
                          {!m.is_read && <span className="mail-unread-dot" />}
                        </span>
                        <span className="row-content">
                          <strong>
                            <HighlightedText text={m.subject || '(No subject)'} query={search} />
                          </strong>
                          <span>
                            <HighlightedText text={m.snippet || 'Open message'} query={search} />
                          </span>
                        </span>
                        {(isSearching || (!mailboxId && data.mailboxes.length > 1)) && (
                          <span className="row-mailbox">
                            {isSearching && (
                              <span className="search-result-folder">{m.folder} · </span>
                            )}
                            {m.mailbox_address ||
                              data.mailboxes.find((b) => b.id === m.mailbox_id)?.address}
                          </span>
                        )}
                        <span className="row-meta">
                          {!!m.attachment_count && <Paperclip size={14} />}
                          <time title={new Date(m.created_at).toLocaleString()}>
                            {dateLabel(m.created_at)}
                          </time>
                        </span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="row-more"
                            aria-label={`Actions for ${m.subject}`}
                          >
                            <MoreHorizontal size={17} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={busy}
                            onSelect={() => mutate(m, { isRead: !m.is_read })}
                          >
                            {m.is_read ? <Mail /> : <MailOpen />}
                            {m.is_read ? 'Mark as unread' : 'Mark as read'}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={busy}
                            onSelect={() =>
                              mutate(m, { folder: m.folder === 'archive' ? 'inbox' : 'archive' })
                            }
                          >
                            <Archive />
                            {m.folder === 'archive' ? 'Move to inbox' : 'Archive'}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={busy}
                            onSelect={() => mutate(m, { folder: 'trash' })}
                          >
                            <Trash2 />
                            Move to trash
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    </Fragment>
                  ))
                )}
                {!listLoading &&
                  !listError &&
                  (showingDrafts ? !drafts.length : !messages.length) && (
                    <div className="inbox-empty">
                      <Empty
                        title={
                          search
                            ? 'No messages found'
                            : unread
                              ? 'No unread messages'
                              : !data.mailboxes.length
                                ? 'No mailboxes yet'
                                : view === 'drafts'
                                  ? 'No drafts'
                                  : view === 'inbox'
                                    ? 'Your inbox is empty'
                                    : `Nothing in ${title.toLowerCase()} yet`
                        }
                        description={
                          search
                            ? `No matches for “${search}” across all mailboxes and folders. Try a word or phrase from the message, subject, or addresses.`
                            : unread
                              ? 'You’ve read all the messages in this view.'
                              : !data.mailboxes.length
                                ? (data.domains.some(d => d.receiving) ? 'Create a mailbox to start sending and receiving email.' : 'Connect your own domain to start sending and receiving email.')
                                : view === 'drafts'
                                  ? 'Start a message. Your draft is saved as you write.'
                                  : view === 'inbox'
                                    ? 'Incoming messages will appear here.'
                                    : view === 'sent'
                                      ? 'Messages you send will appear here.'
                                      : view === 'starred'
                                        ? 'Star a message to find it here.'
                                        : `Messages you move to ${title.toLowerCase()} will appear here.`
                        }
                        icon={unread ? <CheckCheck /> : <Inbox />}
                        action={
                          <Button
                            variant={search || unread ? 'outline' : 'default'}
                            onClick={() => {
                              if (search || unread) {
                                setQuery('');
                                setUnread(false);
                              } else if (!data.mailboxes.length) {
                                if (data.domains.some(d => d.receiving)) setCreateBox(true);
                                else changeView('settings');
                              }
                              else openCompose();
                            }}
                          >
                            {search || unread
                              ? 'Show all mail'
                              : !data.mailboxes.length
                                ? (data.domains.some(d => d.receiving) ? 'Create a mailbox' : 'Connect your domain')
                                : 'Write a message'}
                          </Button>
                        }
                      />
                    </div>
                  )}
                {nextCursor && !showingDrafts && (
                  <div className="inbox-pagination">
                    <span>
                      Showing {messages.length.toLocaleString()} of {total?.toLocaleString()}
                    </span>
                    <Button
                      variant="outline"
                      disabled={listLoading}
                      onClick={() => void loadList(nextCursor)}
                    >
                      {listLoading ? <Spinner /> : <ArrowDown size={15} />}Load more messages
                    </Button>
                  </div>
                )}
              </div>
            </section>
            <section id="mail-reading-pane" className="mail-reader-surface" aria-label="Message content" hidden={isMobile && !selected}>
                {!selected ? (
                  <div className="mail-reader-empty">
                    <h2>{showingDrafts ? 'Your drafts' : 'No message selected'}</h2>
                    <p>{showingDrafts ? 'Choose a draft to keep writing.' : 'Choose an email to read it here.'}</p>
                    <div className="reader-empty-shortcuts" aria-label="Keyboard shortcuts">
                      <span><Kbd>J</Kbd><Kbd>K</Kbd> navigate</span>
                      <span><Kbd>C</Kbd> compose</span>
                      <span><Kbd>/</Kbd> search</span>
                    </div>
                  </div>
                ) : messageLoading || (message?.id !== selected && !messageError) ? (
                  <MailSkeleton reader />
                ) : message ? (
                  <MessageReader
                    key={message.id}
                    message={message}
                    searchQuery={search}
                    busy={busy}
                    onBack={backToList}
                    onReply={() => setCompose({ reply: message })}
                    onForward={() => setCompose({ forward: message })}
                    onMutate={(patch) => mutate(message, patch)}
                    onOpen={openMessage}
                    position={
                      selectionIndex >= 0
                        ? `${selectionIndex + 1} of ${total?.toLocaleString() || messages.length}`
                        : 'Conversation'
                    }
                    onPrevious={selectionIndex > 0 ? () => navigateMessage(-1) : undefined}
                    onNext={
                      selectionIndex >= 0 && (selectionIndex < messages.length - 1 || nextCursor)
                        ? () => navigateMessage(1)
                        : undefined
                    }
                  />
                ) : (
                  <div className="inbox-empty">
                    <Empty
                      title="This message couldn’t be loaded"
                      description={messageError || 'Please try again.'}
                      action={
                        <>
                          <Button onClick={() => setMessageVersion((n) => n + 1)}>Try again</Button>
                          <Button variant="outline" onClick={backToList}>
                            Back to inbox
                          </Button>
                        </>
                      }
                    />
                  </div>
                )}
            </section>
          </div>
        ) : view === 'mailboxes' ? (
          <Mailboxes
            data={data}
            onCreate={() => setCreateBox(true)}
            onDeleted={(box) => {
              setData((current) => ({
                ...current,
                mailboxes: current.mailboxes.filter((item) => item.id !== box.id),
                drafts: current.drafts.filter((draft) => draft.mailbox_id !== box.id),
                counts: current.counts.filter((count) => count.mailbox_id !== box.id),
              }));
              if (mailboxId === box.id) setMailboxId('');
              setSelected(null);
              setMessage(null);
              setChecked(new Set());
              setMessages((current) => current.filter((mail) => mail.mailbox_id !== box.id));
              setCompose(null);
              notify(`${box.address} deleted`);
              void refresh();
            }}
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
          <Settings
            data={data}
            refresh={() => void refresh()}
            notify={notify}
            onDomainsChange={(domains) => setData((current) => ({ ...current, domains }))}
          />
        )}
      </SidebarInset>
      <CommandDialog
        open={commandOpen}
        onOpenChange={setCommandOpen}
        title="Mail commands"
        description="Search commands, switch mailboxes, or find a message."
        className="mail-command-dialog"
        showCloseButton={false}
        commandProps={{
          filter: (value, search, keywords) =>
            value === 'search-mail' ? 0.01 : defaultFilter(value, search, keywords),
        }}
      >
        <CommandInput
          aria-label="Search commands"
          placeholder="Type a command or search your mail…"
          value={commandQuery}
          onValueChange={(value) => setCommandQuery(value.replace(/^\//, ''))}
        />
        <CommandList>
          <CommandEmpty>No matching commands. Try “inbox”, “compose”, or a mailbox.</CommandEmpty>
          <CommandGroup heading="Quick actions">
            <CommandItem
              value="compose"
              keywords={['new message', 'write']}
              onSelect={() => runCommand(openCompose)}
            >
              <SquarePen />
              /compose<CommandShortcut>C</CommandShortcut>
            </CommandItem>
            <CommandItem
              value="search"
              keywords={['find mail']}
              onSelect={() =>
                runCommand(() => {
                  if (!isMail) changeView('inbox');
                  setSelected(null);
                  requestAnimationFrame(() => searchRef.current?.focus());
                })
              }
            >
              <Search />
              /search
            </CommandItem>
            <CommandItem
              value="refresh"
              keywords={['sync']}
              onSelect={() => runCommand(refreshAll)}
            >
              <RefreshCw />
              /refresh
            </CommandItem>
            <CommandItem
              value="sidebar"
              keywords={['collapse', 'expand']}
              onSelect={() => runCommand(toggleSidebar)}
            >
              <ChevronDown />
              /sidebar<CommandShortcut>⌘ B</CommandShortcut>
            </CommandItem>
          </CommandGroup>
          {message && (
            <CommandGroup heading="This message">
              <CommandItem
                value="reply"
                onSelect={() => runCommand(() => setCompose({ reply: message }))}
              >
                <Mail />
                /reply<CommandShortcut>R</CommandShortcut>
              </CommandItem>
              <CommandItem
                value="forward"
                onSelect={() => runCommand(() => setCompose({ forward: message }))}
              >
                <Send />
                /forward<CommandShortcut>F</CommandShortcut>
              </CommandItem>
              <CommandItem
                disabled={busy}
                value="archive message"
                onSelect={() => runCommand(() => mutate(message, { folder: 'archive' }))}
              >
                <Archive />
                /archive-message<CommandShortcut>E</CommandShortcut>
              </CommandItem>
              <CommandItem
                disabled={busy}
                value="unread message"
                onSelect={() => runCommand(() => mutate(message, { isRead: false }))}
              >
                <MailOpen />
                /unread
              </CommandItem>
            </CommandGroup>
          )}
          <CommandSeparator />
          <CommandGroup heading="Go to">
            {[...folders, ...workspaceViews].map(({ id, icon: Icon, label }) => (
              <CommandItem
                value={id}
                keywords={[`go ${label}`]}
                key={id}
                onSelect={() => runCommand(() => changeView(id))}
              >
                <Icon />/{id}
                <CommandShortcut>{label}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Switch mailbox">
            <CommandItem
              value="all mailboxes"
              onSelect={() =>
                runCommand(() => {
                  setMailboxId('');
                  changeView('inbox');
                })
              }
            >
              <Inbox />
              All mailboxes
            </CommandItem>
            {data.mailboxes.map((box) => (
              <CommandItem
                value={box.address}
                keywords={['mailbox', box.name]}
                key={box.id}
                onSelect={() =>
                  runCommand(() => {
                    setMailboxId(box.id);
                    changeView('inbox');
                  })
                }
              >
                <Mail />
                <span>{box.address}</span>
                {box.id === mailboxId && <Check className="ml-auto" />}
              </CommandItem>
            ))}
            <CommandItem
              value="create add mailbox"
              onSelect={() => runCommand(() => setCreateBox(true))}
            >
              <Plus />
              Create a mailbox
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Search mail">
            <CommandItem
              value="search-mail"
              onSelect={() =>
                runCommand(() => {
                  if (!isMail) changeView('inbox');
                  setSelected(null);
                  setQuery(commandQuery);
                  setSearch(commandQuery);
                  if (!commandQuery) requestAnimationFrame(() => searchRef.current?.focus());
                })
              }
            >
              <Search />
              {commandQuery ? `Search mail for “${commandQuery}”` : 'Search all mail'}
              <CommandShortcut>↵</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <div className="command-footer">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span>
            <Kbd>↵</Kbd> select
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </CommandDialog>
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
            refreshAll();
          }}
        />
      )}
      {toast && (
        <div className="mail-toast" role="status">
          <Check size={17} />
          <span>{toast.text}</span>
          {toast.undo && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const undo = toast.undo;
                setToast(null);
                undo?.();
              }}
            >
              Undo
            </Button>
          )}
          <IconButton label="Dismiss notification" onClick={() => setToast(null)}>
            <X size={15} />
          </IconButton>
        </div>
      )}
      {shortcutHelp && (
        <Modal
          title="Make yourself faster"
          subtitle="A few shortcuts for a quieter inbox."
          onClose={() => setShortcutHelp(false)}
        >
          <div className="shortcut-list">
            {[
              ['/', 'Open commands'],
              ['⌘ / Ctrl K', 'Open commands'],
              ['⌘ / Ctrl B', 'Toggle sidebar'],
              ['C', 'Compose a message'],
              ['J / K', 'Next / previous message'],
              ['R', 'Reply'],
              ['F', 'Forward'],
              ['E', 'Archive'],
              ['S', 'Star / unstar'],
              ['Esc', 'Back to message list'],
            ].map(([key, label]) => (
              <div key={key}>
                <span>{label}</span>
                <Kbd>{key}</Kbd>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
function MailSkeleton({ reader = false }: { reader?: boolean }) {
  return (
    <div
      className={`mail-skeleton ${reader ? 'reader-skeleton' : ''}`}
      role="status"
      aria-label="Loading mail"
    >
      <Skeleton className="h-7 w-2/5" />
      <Skeleton className="my-5 h-4 w-3/5" />
      {[0, 1, 2, 3, 4, 5].map((n) => (
        <div className="mail-skeleton-row" key={n}>
          <Skeleton className="size-4 rounded-sm" />
          <Skeleton className="h-4 w-1/5" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
      <span className="sr-only">Loading mail</span>
    </div>
  );
}
