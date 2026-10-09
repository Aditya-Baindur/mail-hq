'use client';
import { useId, useRef, type ReactNode } from 'react';
import { X, Loader2, Inbox } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import {
  Empty as EmptyRoot,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from './ui/empty';
export type Mailbox = {
  id: string;
  address: string;
  name: string;
  color: string;
  status: string;
  unread: number;
  error?: string;
};
export type Domain = {
  connection_ready?: number | null;
  id: string;
  name: string;
  receiving: number;
  sending: number;
  note?: string;
};
export type Attachment = {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  content_id?: string | null;
};
export type Mail = {
  id: string;
  mailbox_id: string;
  mailbox_address?: string;
  mailbox_color?: string;
  sender: string;
  sender_name: string;
  recipients: string[];
  cc: string[];
  bcc: string[];
  reply_to?: string;
  subject: string;
  snippet: string;
  created_at: string;
  is_read: number;
  starred: number;
  folder: string;
  direction: string;
  status: string;
  error?: string;
  message_id?: string | null;
  attachment_count?: number;
  attachments?: Attachment[];
  html?: string;
  text?: string;
  hasRaw?: boolean;
};
export type Draft = { id: string; mailbox_id: string; data: ComposeData; updated_at: string };
export type ComposeData = {
  mailboxId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  html: string;
  attachments: Attachment[];
  replyToId?: string;
  idempotencyKey: string;
};
export type Bootstrap = {
  isAdmin?: boolean;
  ownerConfigured?: boolean;
  appOrigin?: string;
  mailboxes: Mailbox[];
  domains: Domain[];
  drafts: Draft[];
  counts: { mailbox_id?: string; folder: string; count: number; unread: number }[];
  identity: string;
  provisioningConfigured: boolean;
  mcpUrl: string;
};
export async function api<T = Record<string, unknown>>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body && typeof options.body === 'string'
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...options.headers,
    },
  });
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('Your session has expired. Refresh the page to sign in.');
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}
export function bytes(n: number) {
  return n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
}
export function dateLabel(value: string) {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
export function initials(value: string) {
  return value
    .split(/[\s@._-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0])
    .join('')
    .toUpperCase();
}
export function sendStatus(status: string) {
  switch (status) {
    case 'accepted':
      return {
        label: 'Sent to Cloudflare',
        detail:
          'Cloudflare accepted this message for sending. Mail HQ has not confirmed recipient delivery or Inbox placement. If it is missing, ask the recipient to check Spam and All Mail.',
        warning: false,
      };
    case 'sending':
      return {
        label: 'Sending',
        detail: 'The send request is still in progress. Check its status before sending again.',
        warning: false,
      };
    case 'failed':
      return {
        label: 'Send failed',
        detail: 'This message could not be submitted. See the error below.',
        warning: true,
      };
    default:
      return {
        label: 'Send unconfirmed',
        detail:
          'This message may have been sent, but confirmation is unavailable. Check with the recipient before resending to avoid a duplicate.',
        warning: true,
      };
  }
}
export function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  active = false,
  className = '',
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={`icon-button ${active ? 'active' : ''} ${className}`}
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  );
}
export function Spinner() {
  return <Loader2 size={17} className="spin" aria-label="Loading" />;
}
export function Empty({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <EmptyRoot>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon || <Inbox size={24} strokeWidth={1.5} />}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </EmptyRoot>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const trigger = useRef(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement),
  );
  const descriptionId = useId();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className={`modal ${wide ? 'wide' : ''}`}
        showCloseButton={false}
        aria-describedby={subtitle ? descriptionId : undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (trigger.current?.isConnected) trigger.current.focus();
        }}
      >
        <div className="modal-header">
          <div>
            <DialogTitle>{title}</DialogTitle>
            {subtitle && <DialogDescription id={descriptionId}>{subtitle}</DialogDescription>}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X size={19} />
          </IconButton>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function ErrorNote({ message }: { message: string }) {
  return message ? (
    <div className="error-note" role="alert">
      {message}
    </div>
  ) : null;
}
export function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
