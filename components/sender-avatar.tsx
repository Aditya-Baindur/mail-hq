import { initials } from './shared';

/** A stable, local identity mark; viewing mail never fetches a sender's profile. */
export function SenderAvatar({ name, address, className = '' }: {
  name?: string;
  address: string;
  className?: string;
}) {
  const tone = Array.from(address.toLowerCase()).reduce((hash, char) =>
    (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 6;
  return (
    <span className={`sender-avatar ${className}`} data-tone={tone} aria-hidden="true">
      {initials(name || address.split('@')[0]) || '?'}
    </span>
  );
}
