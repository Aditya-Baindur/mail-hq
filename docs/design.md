# Mail HQ interface

Mail HQ follows the product design system in UseAbout (`../useabout.com/DESIGN.md` and its dashboard components).

Use the shared semantic tokens in `app/globals.css`: white canvas, #171717 text and primary actions, #666 secondary text, #eaeaea separators, #fafafa navigation, and blue focus rings. Color indicates status rather than decorating the workspace.

The workspace fills the viewport without an inset card or static shadows. Keep navigation at 224px, a separate message list, and a white reading pane. Below 768px, show the list or message individually. Mobile controls must remain at least 40px targets.

Use Geist for interface text and Geist Mono for addresses, timestamps, and identifiers. Titles are 24–28px, primary interface text 14px, and supporting copy 13px. Use 6px control radii, thin borders, consistent 24px gutters, and separators between message rows. Avoid pastel identity colors, decorative empty-state illustrations, and promotional copy inside the mail interface.

Workspace-specific styles live in `app/mail-workspace.css`; shared controls, management pages, and dialogs use `app/globals.css`. Keep both on the same tokens so portaled dialogs and mobile navigation do not introduce another theme.
