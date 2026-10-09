# MailHQ design

The user rejected the generic dashboard and the flat blue mail UI. The current direction is warm paper, dark ink, and a restrained evergreen accent. Keep the Apple Mail / Outlook interaction model: navigation on the left, a persistent message list in the middle, and the selected email on the right. Opening mail must not replace the list on desktop or tablet. On phones, show the list or reader with a Back action.

## References

- [Linear's UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui): distinct panel hierarchy, aligned navigation, controlled density, quiet application chrome.
- [Shortwave's inbox](https://www.shortwave.com/blog/introducing-shortwave/): recognizable sender identities and chronological sections that make a busy inbox easy to scan.

Use these principles, not their brand assets. `app/mail-workspace.css` is the authoritative mail styling layer; older dashboard rules in `globals.css` must not override it.

## Visual system

- Warm gray navigation (`#f0efeb`), off-white list (`#fcfcfa`), white reading surface, dark evergreen primary actions (`#293e34`), and pale sage selected messages (`#e9efe2`). No full-row saturated blue selection.
- Use the bundled Geist family with native system fallbacks. Main headings are 28px, message subjects 25–28px, list sender/subject 13px, preview 12px, email body 14–15px. Metadata stays secondary without sacrificing readability.
- Give the desktop content a restrained inset frame. Use thin separators and spacing for structure. Avoid decorative gradients, dashboard statistic cards, marketing copy, and invented status claims.
- Compose is a prominent action in the sidebar, with a compact duplicate in the inbox header. Keep workspace management quieter near the bottom of navigation.
- Group message rows by date. Use consistent local sender initials in muted circular avatars; never contact third-party services to identify senders. Reveal selection controls on hover/focus, and keep them available to touch users.
- Selected mail stays highlighted in the list; navigation keeps it visible. Preserve the list's scroll position and pagination. List and reader scroll independently.
- The reader gives the subject and sender room above the body. Find controls open on request or automatically for a search result. Image and plain-text controls live in the message menu; display a notice when a non-default mode is active.
- Preserve global search, body highlights, next/previous match navigation, commands, keyboard shortcuts, safe HTML rendering, attachments, external-image controls, and undo.
- Make small-screen touch targets at least 40px, prevent horizontal overflow, preserve visible keyboard focus, and respect reduced motion.

## Verification

Check desktop 1440×900, tablet 768×1024, mobile 390×844, and narrow mobile 320px. Test opening/switching messages, sidebar collapse, search, find, bulk selection, compose, and scrolling. Use real screenshots when browser tooling is available; distinguish DOM tests and build checks from visual verification when it is unavailable.
