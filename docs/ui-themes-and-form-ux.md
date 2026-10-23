# Server themes and guided ticket-form UX

## Server-specific themes

Each guild stores its selected theme in the existing guild-config PostgreSQL-backed JSON document. Existing guilds are normalized to Midnight Indigo on first read; no SQL migration, reset, or SQLite provider is added.

Available themes:

- Midnight Indigo: clean, professional indigo
- Cyber Neon: electric cyan
- Deep Ocean: teal blue
- Aurora Violet: violet
- Ember Orange: warm orange
- Forest Green: green

Administrators can choose the theme from Settings → Server Theme or use /qf settings theme with action:set and a palette. Use action:show to report the active palette. Updating a theme refreshes that server's public support panel and settings dashboard; other guilds retain their own selection.

The theme accent applies to the public support panel (including department pagination), Settings dashboard and subviews, Ticket Forms screens and answer summaries, ticket history and voice notices, internal-note messages, and the audit control panel, audit entries, daily/overall summaries, and private developer view. Changing a server theme refreshes its existing support, settings, and audit panels. Ticket detail panels retain priority-specific accents because priority color is an operational signal. Discord's native modal and button colors cannot be customized with HTML/CSS, so those controls stay native and accessible.

## Guided form builder

Ticket Forms now offers two authoring paths:

- Guided Form Builder asks the administrator to choose a department and tag, then supply a form name and one or two question labels. It generates validated short-text fields and creates the form inactive for review.
- Advanced Schema remains available for dropdowns, multi-select, numeric/date fields, attachments, Discord user/role selectors, conditional multi-step questions, patterns, and other schema options.

The guided flow and /qf form quick-create use the same buildQuickTicketFormFields normalizer and existing versioned form service. They do not create a separate persistence path. All form records and submissions remain in Neon PostgreSQL.

Ticket Forms screens render as themed embeds with readable headings, predictable spacing, clear status details, and consistent navigation. Native ticket modals show clearer prompts and explicitly mark required versus optional custom fields.

## Verification expectations

Run the TypeScript build, automated tests, and PostgreSQL verification. Then test both the button-driven and slash-command theme paths in separate Discord test servers to confirm changing one server's theme does not affect another. Test the guided builder with one question, two questions, duplicate labels, missing department/tag, and an invalid or renamed mapping.
