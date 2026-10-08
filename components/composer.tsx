'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Combobox } from './ui/combobox';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  ArrowUp,
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Link,
  Paperclip,
  Trash2,
  X,
  Quote,
  Check,
  Undo2,
  Type,
} from 'lucide-react';
import {
  api,
  bytes,
  ErrorNote,
  escapeHtml,
  IconButton,
  Modal,
  Spinner,
  type Attachment,
  type ComposeData,
  type Draft,
  type Mail,
  type Mailbox,
} from './shared';
export function Composer({
  mailboxes,
  initialMailbox,
  reply,
  forward,
  draft,
  onClose,
  onSent,
}: {
  mailboxes: Mailbox[];
  initialMailbox?: string;
  reply?: Mail;
  forward?: Mail;
  draft?: Draft;
  onClose: () => void;
  onSent: () => void;
}) {
  const active = mailboxes.filter((b) => b.status === 'active');
  const id = useRef(draft?.id || crypto.randomUUID());
  const editor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const alive = useRef(true);
  const saveDisabled = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [data, setData] = useState<ComposeData>(
    () =>
      draft?.data || {
        mailboxId: reply?.mailbox_id || initialMailbox || active[0]?.id || '',
        to: reply
          ? reply.direction === 'outbound'
            ? reply.recipients.join(', ')
            : reply.reply_to || reply.sender
          : '',
        cc: '',
        bcc: '',
        subject: reply
          ? /^re:/i.test(reply.subject)
            ? reply.subject
            : `Re: ${reply.subject}`
          : forward
            ? `Fwd: ${forward.subject}`
            : '',
        text: forward
          ? `\n\n---------- Forwarded message ----------\nFrom: ${forward.sender}\nSubject: ${forward.subject}\n\n${forward.text || forward.snippet}`
          : '',
        html: forward
          ? `<p><br></p><blockquote>${escapeHtml(`From: ${forward.sender}\nSubject: ${forward.subject}\n\n${forward.text || forward.snippet}`).replace(/\n/g, '<br>')}</blockquote>`
          : '',
        attachments: [],
        replyToId: reply?.id,
        idempotencyKey: crypto.randomUUID(),
      },
  );
  const [extra, setExtra] = useState(!!(draft?.data.cc || draft?.data.bcc));
  const [formatting, setFormatting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const selection = useRef<Range | null>(null);
  const initialContent = useRef(data.html || escapeHtml(data.text).replace(/\n/g, '<br>'));
  // Dialog content mounts in a portal after this component's first effect.
  const attachEditor = useCallback((node: HTMLDivElement | null) => {
    editor.current = node;
    if (node) node.innerHTML = initialContent.current;
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const update = (values: Partial<ComposeData>) => {
    setSaved(false);
    setData((d) => ({ ...d, ...values }));
  };
  const save = (value: ComposeData) => {
    saveChain.current = saveChain.current
      .catch(() => {})
      .then(() =>
        api(`/drafts/${id.current}`, {
          method: 'PUT',
          body: JSON.stringify({ mailboxId: value.mailboxId, data: value }),
        }),
      );
    return saveChain.current;
  };
  useEffect(() => {
    if (saveDisabled.current || !data.mailboxId || (!data.subject && !data.text && !data.to))
      return;
    const timer = setTimeout(() => {
      if (saveDisabled.current) return;
      save(data)
        .then(() => {
          if (alive.current) setSaved(true);
        })
        .catch((e) => {
          if (alive.current) setError(e.message);
        });
    }, 900);
    saveTimer.current = timer;
    return () => clearTimeout(timer);
  }, [data]);
  function command(name: string, value?: string) {
    editor.current?.focus();
    document.execCommand(name, false, value);
    if (editor.current) update({ html: editor.current.innerHTML, text: editor.current.innerText });
  }
  function pauseSave() {
    saveDisabled.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }
  async function close() {
    if (busy) return;
    pauseSave();
    setBusy(true);
    try {
      if (data.subject || data.text || data.to) await save(data);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      saveDisabled.current = false;
      setBusy(false);
    }
  }
  async function discard() {
    pauseSave();
    setBusy(true);
    try {
      await saveChain.current.catch(() => {});
      await api(`/drafts/${id.current}`, { method: 'DELETE' });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      saveDisabled.current = false;
      setBusy(false);
    }
  }
  async function submit() {
    if (busy || uploading) return;
    pauseSave();
    setBusy(true);
    setError('');
    try {
      await saveChain.current.catch(() => {});
      const recipients = (value: string) =>
        value
          .split(/[,;]+/)
          .map((x) => x.trim())
          .filter(Boolean);
      const result = await api<{ status: string; error?: string }>('/send', {
        method: 'POST',
        body: JSON.stringify({
          ...data,
          to: recipients(data.to),
          cc: recipients(data.cc),
          bcc: recipients(data.bcc),
          attachmentIds: data.attachments.map((a) => a.id),
          draftId: id.current,
        }),
      });
      if (result.status !== 'accepted')
        throw new Error(
          result.error ||
            (result.status === 'sending'
              ? 'This message is still being processed. Check Sent before retrying.'
              : 'Delivery status is uncertain. Check Sent before sending again.'),
        );
      onSent();
    } catch (e) {
      setError((e as Error).message);
      saveDisabled.current = false;
      setBusy(false);
    }
  }
  async function upload(files: FileList | null) {
    if (!files) return;
    setUploading(true);
    setError('');
    try {
      const uploaded: Attachment[] = [];
      for (const file of Array.from(files)) {
        if (file.size > 3 * 1024 * 1024) throw new Error('Each attachment must be under 3 MB.');
        uploaded.push(
          await api<Attachment>(`/attachments?mailboxId=${data.mailboxId}`, {
            method: 'POST',
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
              'X-Filename': encodeURIComponent(file.name),
            },
            body: file,
          }),
        );
      }
      update({ attachments: [...data.attachments, ...uploaded] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }
  return (
    <Modal
      title={reply ? 'Reply' : forward ? 'Forward message' : draft ? 'Draft' : 'New message'}
      onClose={() => void close()}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="compose-fields">
          <label>
            <span>From</span>
            <Combobox
              label="Send from mailbox"
              className="sender-combobox"
              searchPlaceholder="Search senders…"
              emptyText="No sending mailboxes found."
              value={data.mailboxId}
              disabled={!!reply || data.attachments.length > 0 || busy}
              onValueChange={(mailboxId) => update({ mailboxId })}
              options={active.map((b) => ({ value: b.id, label: b.address, description: b.name }))}
            />
          </label>
          <label>
            <span>To</span>
            <Input
              autoFocus={!reply}
              required
              aria-label="Recipients"
              placeholder="name@example.com"
              value={data.to}
              onChange={(e) => update({ to: e.target.value })}
            />
            <button type="button" className="text-button" onClick={() => setExtra(!extra)}>
              Cc / Bcc
            </button>
          </label>
          {extra && (
            <>
              <label>
                <span>Cc</span>
                <Input
                  aria-label="Cc recipients"
                  value={data.cc}
                  onChange={(e) => update({ cc: e.target.value })}
                />
              </label>
              <label>
                <span>Bcc</span>
                <Input
                  aria-label="Bcc recipients"
                  value={data.bcc}
                  onChange={(e) => update({ bcc: e.target.value })}
                />
              </label>
            </>
          )}
          <label>
            <span>Subject</span>
            <Input
              required
              aria-label="Subject"
              placeholder="Subject"
              value={data.subject}
              onChange={(e) => update({ subject: e.target.value })}
            />
          </label>
        </div>
        {formatting && (
          <div className="format-bar" role="toolbar" aria-label="Text formatting">
            {[
              [Bold, 'Bold', 'bold'],
              [Italic, 'Italic', 'italic'],
              [Underline, 'Underline', 'underline'],
              [List, 'Bullet list', 'insertUnorderedList'],
              [ListOrdered, 'Numbered list', 'insertOrderedList'],
              [Quote, 'Quote', 'formatBlock'],
              [Undo2, 'Undo', 'undo'],
            ].map(([Icon, label, cmd]) => {
              const I = Icon as typeof Bold;
              return (
                <button
                  key={label as string}
                  type="button"
                  aria-label={label as string}
                  title={label as string}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    command(cmd as string, cmd === 'formatBlock' ? 'blockquote' : undefined)
                  }
                >
                  <I size={16} />
                </button>
              );
            })}
            <button
              type="button"
              aria-label="Insert link"
              title="Insert link"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const s = window.getSelection();
                selection.current = s?.rangeCount ? s.getRangeAt(0) : null;
                setLink('');
              }}
            >
              <Link size={16} />
            </button>
          </div>
        )}
        {link !== null && (
          <div className="link-input">
            <Input
              aria-label="Link URL"
              autoFocus
              placeholder="https://example.com"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
            <Button
              type="button"
              className="small-button"
              onClick={() => {
                try {
                  const url = new URL(link);
                  if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new Error();
                  editor.current?.focus();
                  if (selection.current) {
                    const s = window.getSelection();
                    s?.removeAllRanges();
                    s?.addRange(selection.current);
                  }
                  command('createLink', url.href);
                  setLink(null);
                } catch {
                  setError('Use a valid https:// or mailto: link.');
                }
              }}
            >
              Add link
            </Button>
            <IconButton label="Cancel link" onClick={() => setLink(null)}>
              <X size={14} />
            </IconButton>
          </div>
        )}
        <div
          ref={attachEditor}
          className="rich-editor"
          contentEditable={!busy}
          role="textbox"
          aria-label="Message body"
          aria-multiline="true"
          data-placeholder="Write a message…"
          suppressContentEditableWarning
          onInput={() =>
            update({ html: editor.current?.innerHTML || '', text: editor.current?.innerText || '' })
          }
          onPaste={(e) => {
            e.preventDefault();
            document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
          }}
        />
        {data.attachments.length > 0 && (
          <div className="compose-attachments">
            {data.attachments.map((a) => (
              <span key={a.id}>
                <Paperclip size={13} />
                {a.filename}
                <small>{bytes(a.size)}</small>
                <button
                  type="button"
                  aria-label={`Remove ${a.filename}`}
                  onClick={() =>
                    update({ attachments: data.attachments.filter((f) => f.id !== a.id) })
                  }
                >
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="compose-error">
          <ErrorNote message={error} />
        </div>
        <div className="compose-footer">
          <Button
            type="submit"
            className="primary"
            disabled={busy || uploading || !data.mailboxId || !data.text.trim()}
          >
            {busy ? <Spinner /> : <ArrowUp size={17} />}Send
          </Button>
          <IconButton
            label="Formatting options"
            active={formatting}
            onClick={() => setFormatting(!formatting)}
          >
            <Type size={17} />
          </IconButton>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => void upload(e.target.files)}
          />
          <IconButton
            label="Attach files"
            disabled={busy || uploading}
            onClick={() => input.current?.click()}
          >
            {uploading ? <Spinner /> : <Paperclip size={18} />}
          </IconButton>
          <span className="draft-status">
            {saved && (
              <>
                <Check size={13} /> Draft saved
              </>
            )}
          </span>
          <IconButton label="Discard draft" disabled={busy} onClick={() => void discard()}>
            <Trash2 size={17} />
          </IconButton>
        </div>
      </form>
    </Modal>
  );
}
