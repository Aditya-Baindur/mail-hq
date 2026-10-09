'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { highlightDocument, highlightStyles, type HighlightMatches } from '../lib/search-highlight';
import { HighlightedText } from './search-highlight';
import { SenderAvatar } from './sender-avatar';
import { Input } from './ui/input';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Image,
  Mail,
  MoreHorizontal,
  Paperclip,
  Reply,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { ScrollArea } from './ui/scroll-area';
import { Separator } from './ui/separator';
import { Skeleton } from './ui/skeleton';
import {
  api,
  bytes,
  dateLabel,
  ErrorNote,
  IconButton,
  sendStatus,
  type Mail as MailData,
} from './shared';

export function MessageReader({
  message: m,
  searchQuery = '',
  busy,
  onBack,
  onReply,
  onForward,
  onMutate,
  onOpen,
  position,
  onPrevious,
  onNext,
}: {
  message: MailData;
  searchQuery?: string;
  busy: boolean;
  onBack: () => void;
  onReply: () => void;
  onForward: () => void;
  onMutate: (patch: Record<string, unknown>) => void;
  onOpen: (id: string) => void;
  position: string;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const [showHtml, setShowHtml] = useState(true);
  const [showImages, setShowImages] = useState(true);
  const [thread, setThread] = useState<MailData[]>([]);
  const [findQuery, setFindQuery] = useState(searchQuery);
  const [showFind, setShowFind] = useState(!!searchQuery.trim());
  const findInput = useRef<HTMLInputElement>(null);
  const findTrigger = useRef<HTMLButtonElement>(null);
  const [matches, setMatches] = useState<HighlightMatches>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const receiveMatches = useCallback((found: HighlightMatches) => {
    setMatches(found);
    setMatchIndex(0);
  }, []);
  useEffect(() => {
    setFindQuery(searchQuery);
    if (searchQuery.trim()) setShowFind(true);
  }, [searchQuery]);
  const closeFind = () => {
    setShowFind(false);
    setFindQuery('');
    findTrigger.current?.focus();
  };
  useEffect(() => {
    matches.forEach((group, i) =>
      group.forEach((mark) => {
        mark.dataset.active = String(i === matchIndex);
      }),
    );
    // Wait for iframe sizing and React layout before jumping into a long email.
    let timer = requestAnimationFrame(() => {
      timer = requestAnimationFrame(() => {
        matches[matchIndex]?.[0]?.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    });
    return () => cancelAnimationFrame(timer);
  }, [matches, matchIndex]);
  const moveMatch = (direction: number) => {
    if (matches.length) setMatchIndex((i) => (i + direction + matches.length) % matches.length);
  };
  const heading = useRef<HTMLHeadingElement>(null);
  const sending = m.direction === 'outbound' ? sendStatus(m.status) : null;
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    const controller = new AbortController();
    api<{ messages: MailData[] }>(`/messages/${m.id}/thread`, { signal: controller.signal })
      .then((d) => {
        if (!controller.signal.aborted) setThread(d.messages);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [m.id]);
  return (
    <>
      <div className="mail-reader-toolbar">
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="reader-back"
            aria-label="Back"
          >
            <ArrowLeft size={17} />
            <span>Back</span>
          </Button>
          <Separator orientation="vertical" className="reader-back-separator h-5!" />
          <IconButton
            disabled={busy}
            label={m.folder === 'archive' ? 'Move to inbox' : 'Archive · E'}
            onClick={() => onMutate({ folder: m.folder === 'archive' ? 'inbox' : 'archive' })}
          >
            <Archive size={17} />
          </IconButton>
          <IconButton
            disabled={busy}
            label="Move to trash"
            onClick={() => onMutate({ folder: 'trash' })}
          >
            <Trash2 size={17} />
          </IconButton>
          <IconButton
            disabled={busy}
            label="Mark as unread"
            onClick={() => onMutate({ isRead: false })}
          >
            <Mail size={17} />
          </IconButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More message actions">
                <MoreHorizontal size={17} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem disabled={busy} onSelect={() => onMutate({ folder: 'inbox' })}>
                <Mail />
                Move to inbox
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onSelect={() => onMutate({ folder: 'spam' })}>
                <ShieldCheck />
                Move to spam
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setShowHtml((v) => !v)}>
                <FileText />
                {showHtml ? 'View plain text' : 'View formatted email'}
              </DropdownMenuItem>
              {m.html && (
                <DropdownMenuItem onSelect={() => setShowImages((v) => !v)}>
                  <Image />
                  {showImages ? 'Hide external images' : 'Show external images'}
                </DropdownMenuItem>
              )}
              {m.hasRaw && (
                <DropdownMenuItem asChild>
                  <a href={`/api/messages/${m.id}/raw`} download>
                    <Download />
                    Download original email
                  </a>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div>
          <Button
            ref={findTrigger}
            variant="ghost"
            size="icon-sm"
            className="icon-button reader-find-toggle"
            aria-label="Find in this email"
            title="Find in this email"
            aria-expanded={showFind}
            aria-controls="mail-find-controls"
            onClick={() => {
              if (showFind) closeFind();
              else {
                setShowFind(true);
                requestAnimationFrame(() => findInput.current?.focus());
              }
            }}
          >
            <Search size={17} />
          </Button>
          <Separator orientation="vertical" className="reader-navigation-separator h-5!" />
          <span className="reader-position">{position}</span>
          <IconButton
            label="Previous message · K"
            disabled={!onPrevious || busy}
            onClick={onPrevious}
          >
            <ChevronLeft size={18} />
          </IconButton>
          <IconButton label="Next message · J" disabled={!onNext || busy} onClick={onNext}>
            <ChevronRight size={18} />
          </IconButton>
        </div>
      </div>
      {showFind && <div id="mail-find-controls" className="mail-find-bar" role="search" aria-label="Find in this email">
        <Search size={16} aria-hidden="true" />
        <Input
          ref={findInput}
          aria-label="Find text in this email"
          placeholder="Find in this email…"
          value={findQuery}
          maxLength={200}
          onChange={(event) => setFindQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              moveMatch(event.shiftKey ? -1 : 1);
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              closeFind();
            }
          }}
        />
        <span className="mail-find-count" role="status" aria-live="polite">
          {findQuery.trim()
            ? matches.length
              ? `${matchIndex + 1} of ${matches.length} in body`
              : 'No body matches'
            : ''}
        </span>
        <IconButton label="Previous match" disabled={!matches.length} onClick={() => moveMatch(-1)}>
          <ChevronLeft size={16} />
        </IconButton>
        <IconButton label="Next match" disabled={!matches.length} onClick={() => moveMatch(1)}>
          <ChevronRight size={16} />
        </IconButton>
        {!!findQuery && (
          <Button variant="ghost" size="sm" aria-label="Clear highlights" onClick={() => setFindQuery('')}>Clear</Button>
        )}
        <IconButton label="Close find" onClick={closeFind}><X size={15} /></IconButton>
      </div>}
      <ScrollArea className="mail-reader-scroll">
        <article className="mail-reading-document">
          <div className="reader-subject">
            <div>
              <div className="reader-labels">
                <span className="reader-folder">{m.folder}</span>
                {thread.length > 1 && <Badge variant="outline">{thread.length} messages</Badge>}
                {sending && (
                  <Badge
                    variant={sending.warning ? 'destructive' : 'outline'}
                    title={sending.detail}
                  >
                    {sending.label}
                  </Badge>
                )}
              </div>
              <h2 ref={heading} tabIndex={-1}>
                <HighlightedText text={m.subject || '(No subject)'} query={findQuery} />
              </h2>
            </div>
            <IconButton
              disabled={busy}
              label={m.starred ? 'Remove star · S' : 'Star message · S'}
              active={!!m.starred}
              onClick={() => onMutate({ starred: !m.starred })}
            >
              <Star size={20} fill={m.starred ? 'currentColor' : 'none'} />
            </IconButton>
          </div>
          {thread.length > 1 && (
            <div className="mail-thread">
              {thread
                .filter((x) => x.id !== m.id)
                .map((x) => (
                  <Button variant="ghost" key={x.id} onClick={() => onOpen(x.id)}>
                    <Reply size={15} />
                    <strong>{x.sender_name || x.sender}</strong>
                    <span>{x.snippet}</span>
                    <time>{dateLabel(x.created_at)}</time>
                    <ChevronRight size={15} />
                  </Button>
                ))}
            </div>
          )}
          <div className="reader-sender">
            <SenderAvatar name={m.sender_name} address={m.sender} />
            <div className="reader-sender-info">
              <strong>
                <HighlightedText text={m.sender_name || m.sender} query={findQuery} />
              </strong>
              <span className="sender-address">
                <HighlightedText text={m.sender_name ? m.sender : ''} query={findQuery} />
              </span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="reader-recipients">
                    to <HighlightedText text={m.recipients.join(', ')} query={findQuery} />
                    <ChevronDown size={13} />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="reader-details">
                  <dl>
                    {[
                      ['From', m.sender],
                      ['To', m.recipients.join(', ')],
                      ...(m.cc.length ? [['Cc', m.cc.join(', ')]] : []),
                      ...(m.bcc.length ? [['Bcc', m.bcc.join(', ')]] : []),
                      ['Date', new Date(m.created_at).toLocaleString()],
                      ...(m.reply_to ? [['Reply to', m.reply_to]] : []),
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>
                          <HighlightedText text={value} query={findQuery} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {sending && <p>{sending.detail}</p>}
                </PopoverContent>
              </Popover>
            </div>
            <time className="reader-date" title={new Date(m.created_at).toLocaleString()}>
              {new Date(m.created_at).toLocaleDateString([], {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
              <span>
                {new Date(m.created_at).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
            </time>
            <IconButton label="Reply · R" onClick={onReply}>
              <Reply size={18} />
            </IconButton>
          </div>
          {m.error && <ErrorNote message={m.error} />}
          {m.html && (!showHtml || !showImages) && (
            <div className="reader-format-bar">
              <span>{!showHtml ? 'Plain text view' : 'External images hidden'}</span>
              <Button variant="ghost" size="sm" onClick={() => { setShowHtml(true); setShowImages(true); }}>
                Show original formatting
              </Button>
            </div>
          )}
          {m.html && showHtml ? (
            <EmailBody
              message={m}
              showImages={showImages}
              query={findQuery}
              onMatches={receiveMatches}
            />
          ) : (
            <PlainBody
              text={m.text || m.snippet || 'This message has no text content.'}
              query={findQuery}
              onMatches={receiveMatches}
            />
          )}
          {!!m.attachments?.length && (
            <section className="mail-attachments" aria-label="Attachments">
              <h3>
                <Paperclip size={15} />
                {m.attachments.length} attachment{m.attachments.length !== 1 ? 's' : ''}
              </h3>
              <div>
                {m.attachments.map((a) => (
                  <Button variant="outline" asChild className="mail-attachment" key={a.id}>
                    <a href={`/api/attachments/${a.id}`} download>
                      <FileText size={24} />
                      <span>
                        <strong>{a.filename}</strong>
                        <small>{bytes(a.size)}</small>
                      </span>
                      <Download size={16} />
                    </a>
                  </Button>
                ))}
              </div>
            </section>
          )}
          <div className="reader-reply-bar">
            <Button onClick={onReply}>
              <Reply size={16} />
              Reply<span className="reply-shortcut">R</span>
            </Button>
            <Button variant="outline" onClick={onForward}>
              <ArrowRight size={16} />
              Forward
            </Button>
          </div>
        </article>
      </ScrollArea>
    </>
  );
}

function PlainBody({
  text,
  query,
  onMatches,
}: {
  text: string;
  query: string;
  onMatches: (matches: HighlightMatches) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onMatches(
      Array.from(
        body.current?.querySelectorAll<HTMLElement>('mark[data-mail-search-match]') || [],
        (mark) => [mark],
      ),
    );
  }, [text, query, onMatches]);
  return (
    <div className="mail-plain-body" ref={body}>
      <HighlightedText text={text} query={query} />
    </div>
  );
}

function EmailBody({
  message,
  showImages,
  query,
  onMatches,
}: {
  message: MailData;
  showImages: boolean;
  query: string;
  onMatches: (matches: HighlightMatches) => void;
}) {
  const [documentHtml, setDocumentHtml] = useState('');
  const [height, setHeight] = useState(360);
  const [wide, setWide] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const [loadedDocument, setLoadedDocument] = useState<Document | null>(null);
  useEffect(() => {
    onMatches(loadedDocument?.body ? highlightDocument(loadedDocument.body, query) : []);
  }, [loadedDocument, query, onMatches]);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const urls: string[] = [];
    void (async () => {
      // Sanitize before granting same-origin access for parent-side sizing. The
      // frame still cannot execute scripts, submit forms, or navigate the app.
      const clean = DOMPurify.sanitize(message.html || '', {
        WHOLE_DOCUMENT: true,
        USE_PROFILES: { html: true },
        FORBID_TAGS: [
          'script',
          'noscript',
          'iframe',
          'object',
          'embed',
          'form',
          'input',
          'button',
          'textarea',
          'select',
          'meta',
          'base',
          'link',
          'video',
          'audio',
        ],
        FORBID_ATTR: ['srcdoc', 'autofocus', 'formaction'],
      });
      const doc = new DOMParser().parseFromString(clean, 'text/html');
      doc.querySelectorAll('a').forEach((a) => {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      });
      const inline = (message.attachments || []).filter(
        (a) => a.content_id && /^image\/(png|jpeg|gif|webp|avif)$/i.test(a.content_type),
      );
      await Promise.all(
        inline.map(async (a) => {
          const matching = [...doc.querySelectorAll('img')].filter(
            (img) => img.getAttribute('src') === `cid:${a.content_id?.replace(/^<|>$/g, '')}`,
          );
          if (!matching.length) return;
          try {
            const response = await fetch(`/api/attachments/${a.id}`, { signal: controller.signal });
            if (!response.ok) return;
            const blob = await response.blob();
            if (cancelled) return;
            const url = URL.createObjectURL(blob);
            urls.push(url);
            matching.forEach((img) => {
              img.src = url;
            });
          } catch {
            /* The attachment remains available to download. */
          }
        }),
      );
      doc.querySelectorAll('img').forEach((img) => {
        img.referrerPolicy = 'no-referrer';
      });
      const csp = doc.createElement('meta');
      csp.httpEquiv = 'Content-Security-Policy';
      csp.content = `default-src 'none'; img-src data: blob:${showImages ? ' https: http:' : ''}; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'; script-src 'none'`;
      doc.head.insertBefore(csp, doc.head.firstChild);
      const style = doc.createElement('style');
      style.textContent = `html{color-scheme:light;overflow-x:auto;height:auto!important;min-height:0!important}body{display:flow-root;height:auto!important;min-height:0!important;margin:0;padding:8px 0;font:15px/1.75 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#202124;overflow-wrap:anywhere;min-width:0}img{max-width:100%;height:auto}table{max-width:100%}a{color:#2563eb}pre{white-space:pre-wrap}blockquote{margin-left:0;padding-left:18px;border-left:2px solid #e4e4e7;color:#71717a}`;
      doc.head.appendChild(style);
      const searchStyle = doc.createElement('style');
      searchStyle.textContent = highlightStyles;
      doc.head.appendChild(searchStyle);
      if (!cancelled) setDocumentHtml('<!doctype html>' + doc.documentElement.outerHTML);
    })();
    return () => {
      cancelled = true;
      controller.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [message, showImages]);
  useEffect(() => {
    if (!documentHtml) return;
    // Start measuring as soon as the document exists, without waiting for a
    // slow remote image to finish loading. ResizeObserver handles later images.
    const timer = setInterval(() => {
      if (
        frame.current?.contentDocument?.querySelector('meta[http-equiv="Content-Security-Policy"]')
      ) {
        measure();
        clearInterval(timer);
      }
    }, 50);
    return () => {
      clearInterval(timer);
      observer.current?.disconnect();
    };
  }, [documentHtml]);
  function measure() {
    const doc = frame.current?.contentDocument;
    if (!doc?.body || !frame.current) return;
    setLoadedDocument(doc);
    const update = () => {
      const contentHeight = Math.ceil(doc.body.getBoundingClientRect().height + 24);
      setHeight(Math.max(240, Math.min(contentHeight, 60000)));
      setWide(doc.documentElement.scrollWidth > frame.current!.clientWidth + 2);
    };
    observer.current?.disconnect();
    observer.current = new ResizeObserver(update);
    observer.current.observe(doc.body);
    update();
  }
  return (
    <div className="mail-html-body">
      {!documentHtml ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <iframe
            ref={frame}
            title="Email body"
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            srcDoc={documentHtml}
            onLoad={measure}
            style={{ height }}
          />
          {wide && (
            <p className="email-width-hint">
              This email has a wide layout. Scroll horizontally inside the message to see more.
            </p>
          )}
        </>
      )}
    </div>
  );
}
