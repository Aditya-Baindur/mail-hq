import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Mail HQ',
  description: 'Email, mailboxes, and agent access.',
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
