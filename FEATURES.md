# SupportForge — Feature Tiers

This document categorizes SupportForge's current and possible future
features into **Free**, **Premium**, and **Pro** tiers. No prices are
set here on purpose — this is a product-shape document, not a
pricing page.

Legend:
- ✅ **Built** — real, working code in this repo today.
- 🧪 **Demo-gated** — built and working, but gated behind the
  in-memory demo tier switch (`/supportforge premium toggle-demo`).
  There is no real payment processing anywhere in this bot yet.
- 🔲 **Planned** — a reasonable next step with the current
  architecture (Discord bot only, no new infrastructure).
- 🚧 **Requires new infrastructure** — needs something this repo
  doesn't have yet: a database, a hosted web service, paid AI API
  calls, real payment processing, or third-party API credentials.
  Not safe to fake as working code; each of these is its own
  project.

---

## Free

Core ticketing that every server gets, no tier switch needed.

- ✅ Support Center panel with a Create Ticket button
- ✅ Modal-based ticket creation (subject + description)
- ✅ Private ticket channels with owner + staff + admin permissions
- ✅ Multiple departments, each with its own staff role and panel button
- ✅ Ticket status lifecycle: open → claimed → pending → closed →
  reopened → archived, stored in the channel topic
- ✅ Duplicate-open-ticket prevention (checks status, not just owner ID)
- ✅ HTML transcripts, generated and uploaded *before* a ticket is
  considered closed
- ✅ Add-user / remove-user access control per ticket
- ✅ Ticket creation cooldown (basic anti-spam)
- ✅ `/supportforge setup` and `/supportforge category add`
- 🔲 Closing-reason modal (ask staff for a short reason when closing)
- 🔲 Config validation report in `/supportforge setup` (explicitly
  listing ✅/❌ for each required permission)

## Premium (Demo)

Gated behind the demo tier switch today; no billing exists yet.

- 🧪 Ticket priority levels (Low/Normal/High/Urgent/Critical) with
  channel-name emoji and audit trail
- 🧪 Ticket tags
- 🧪 Internal staff-only notes (logged to the audit channel, never
  visible to the ticket owner)
- 🧪 Audit log channel (ticket created/claimed/pending/closed/
  reopened/archived/priority/tags/notes)
- 🔲 Ticket forms with more fields than subject/description
- 🔲 Conditional form fields per department
- 🔲 Auto-close inactive tickets after a configurable timer
- 🔲 Canned/saved staff responses
- 🔲 Ticket merge (combine duplicate tickets from the same user)
- 🔲 Per-ticket event timeline command (`/supportforge ticket history`)

## Pro (Demo)

Positioned as the tier above Premium. The demo currently treats Pro
the same as Premium (`isPremiumOrHigher`) — there's no Pro-exclusive
gate implemented yet, since none of the Pro-only ideas below are
built.

- 🔲 SLA timers (time-to-claim, time-to-close, breach alerts)
- 🔲 Customer satisfaction ratings after close
- 🔲 Staff performance stats (tickets closed, average response time)
- 🔲 Round-robin / workload-based auto-assignment
- 🔲 Business-hours-aware queueing
- 🚧 AI ticket summaries, suggested replies, sentiment detection,
  smart routing — needs a paid AI API (Anthropic/OpenAI) wired in
  with your own API key, plus cost controls
- 🚧 AI translation — same as above
- 🚧 Voice-channel escalation with speech recognition — needs
  `@discordjs/voice` plus a real-time speech-to-text service; a
  meaningfully different engineering effort from the rest of this bot
- 🚧 Knowledge base / FAQ search — needs a content store and search index

## Enterprise / SaaS layer

Not a "buy this tier" feature set so much as a different product —
running SupportForge as a hosted service across many servers rather
than a single self-hosted bot.

- 🚧 External web dashboard (a separate hosted app + auth)
- 🚧 Multi-server backend with per-guild isolated data — needs a
  real database (Postgres/SQLite/D1); today all ticket state lives
  in Discord channel topics, which is intentionally simple and
  database-ready but not yet backed by one
- 🚧 Real subscription billing (Stripe or similar) replacing the
  demo tier switch
- 🚧 Public API + webhooks
- 🚧 Third-party integrations (Slack, GitHub, Notion, Shopify, etc.)
- 🚧 White-label branding

---

## Why the line is drawn here

Everything marked 🚧 needs infrastructure this repository doesn't
have: a database, a hosted service, a paid external API, or a
payment processor. Building any one of them properly is a project on
its own — they're listed here so the roadmap is honest about what's
next, not implemented as hollow stubs that would look finished
without doing anything.
