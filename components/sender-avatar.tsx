import { initials } from './shared';

/** A stable, local identity mark; viewing mail never fetches a sender's profile. */
export function SenderAvatar({ name, address, className = '' }: {
  name?: string;
  address: string;
  className?: string;
}) {
  return (
    <span className={`sender-avatar ${className}`} aria-hidden="true">
      {initials(name || address.split('@')[0]) || '?'}
    </span>
  );
}
