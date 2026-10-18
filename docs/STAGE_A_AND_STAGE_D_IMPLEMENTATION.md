# Stage A and Stage D Implementation Report

> **Historical checkpoint note:** This report describes an earlier Stage A/Stage D implementation checkpoint and its original verification plan. It is not the current status report. The latest audit is [Stage A–E Inspection and Completion Record](stages-a-to-e-audit.md). Current code includes multi-step conditional forms, form templates, and the Stage E custom panel builder; older scope statements below are superseded where they conflict with the current code and audit.

**Branch:** `stage-a-stage-d`  
**Base checkpoint:** `94bb4cb677038cd93d2e12c2991afe76f4e0c90b`  
**Scope:** Stage A reliability/audit fixes and Stage D advanced ticket forms  
**Production persistence:** Neon PostgreSQL. No SQLite migration or database reset was performed.  
**Verification:** Automated tests were added/updated on this branch, but they were not executed in this working session. GitHub Actions and the local Windows checkout remain the verification path.

## Stage A — reliability and audit review

### Changes in this branch

- Added a durable PostgreSQL ticket-creation lease keyed by guild, ticket owner and department. The existing process-local lock remains as a fast guard; the lease prevents two bot workers from both passing the duplicate-ticket creation guard at once. Leases expire and are released by token so an expired/old worker cannot delete a newer worker's lease.
- Removed the duplicate/unreachable ticket-creation modal routing branch. The single route now parses and validates a versioned form identifier, rejects malformed metadata and forwards the form version/expiry into the creation service.
- Moved active-form routing reads out of Discord's short modal acknowledgement window by using a warmed, periodically refreshed in-memory cache populated from PostgreSQL. A cache refresh failure keeps the last known-good values; a cache that has never loaded returns a visible retry prompt instead of delaying the modal response.
- Hardened form date parsing so impossible dates return a field-validation error rather than allowing `toISOString()` to throw a raw `RangeError`.
- Hardened regular-expression field validation against quantified groups, nested wildcard repetition and backreferences. Patterns are deliberately conservative to avoid running obviously risky user-supplied expressions on the bot event loop.
- Added server-side validation for actual native Discord component values and uploaded file metadata. The validator checks choice membership, numeric bounds, selected server user/role IDs, file host, file size and allowed MIME type instead of trusting the modal UI.
- Fixed the form list to paginate at line boundaries instead of silently truncating routing IDs in the 2,000-character Discord reply.
- Preserved the existing unclaim-runtime-state fix in the base checkpoint: the updated topic, not stale `channel.topic`, is passed to the runtime-state cache. The base fix is unchanged; it was reviewed while integrating the creation/form work.
- Added focused schema/answer-validation tests. They cover required/optional values, duplicate IDs, component count, unsafe regex, patterns, numeric limits, impossible dates, dropdown/multi-select choices, checkboxes, attachment size/MIME and trusted hosts.

### Audit observations and operator follow-up

The tracked source tree did not contain a dedicated Stage A bug-audit report, so this file records the implementation findings. The current architecture already has PostgreSQL as the source of durable ticket state, transactional migrations, a durable event/outbox layer with retry handling, and Discord rate-limit-aware infrastructure. Those foundations were retained.

A code review cannot prove live Discord permissions, actual rate-limit timing, every partial REST failure, or production data quality. Those require GitHub CI plus controlled tests in the bot's Discord server. The local config/database were not reset or rewritten by this branch.

## Stage D — reusable, versioned ticket forms

### Administrator commands

All `/supportforge form` subcommands are behind the command's existing Manage Server/Administrator check.

- `/supportforge form list [page]`: shows form IDs, versions, status, mapping IDs and the existing department/tag IDs used when creating forms.
- `/supportforge form create name department-id tag-id fields-json`: creates an inactive form version 1. Use `*` for `tag-id` to match any tag in that department.
- `/supportforge form update id fields-json`: creates a new immutable schema version; it does not rewrite old versions or prior response snapshots.
- `/supportforge form activate id`: assigns a form to new ticket requests for that routing mapping.
- `/supportforge form deactivate id`: disables it for future requests while keeping historical versions and stored answers.

The form can only map to an existing department and, when specified, a tag belonging to that department. An active exact-tag form takes precedence over an active wildcard form. The PostgreSQL partial unique index prevents two active forms from occupying the same exact mapping.

### Field schema

Supply a JSON array containing between one and three custom fields. Each field has a stable `id`, a user-facing `label`, a supported `type`, and optional `required` / validation properties. Example:

```json
[
  {
    "id": "order_id",
    "label": "Order ID",
    "type": "short_text",
    "required": true,
    "minLength": 4,
    "maxLength": 32,
    "pattern": "^[A-Z0-9-]+$"
  },
  {
    "id": "payment_method",
    "label": "Payment method",
    "type": "dropdown",
    "required": true,
    "choices": ["Card", "UPI", "Crypto"]
  },
  {
    "id": "evidence",
    "label": "Evidence attachment",
    "type": "attachment",
    "required": false,
    "maxBytes": 8388608,
    "allowedMimeTypes": ["image/*", "application/pdf"]
  }
]
```

Supported types: `short_text`, `long_text`, `number`, `decimal`, `url`, `email`, `date`, `dropdown`, `multi_select`, `checkbox`, `discord_user`, `discord_role`, and `attachment`.

Validation supports required/optional values; min/max text length; safe patterns for text; numeric minimum/maximum; allowed selection choices; selected Discord users/roles; and actual attachment size/MIME/source-host checks. Limits and validation are rechecked on submission at the server/service layer.

Discord's current modal layout has five top-level labeled components. The built-in Subject and Description use two, so each form step permits up to three custom fields. Current code supports up to 25 custom fields across at most 10 steps. Conditional fields must depend on earlier steps so the bot can evaluate visibility before displaying the next modal.

### Durable submission and recovery

Migration 6 adds `ticket_forms`, `ticket_form_versions`, `ticket_form_submissions` and `ticket_creation_locks`. Form versions, exact form snapshots, answers, guild/user/form identifiers, submission time, and available ticket/channel linkage are stored in Neon PostgreSQL. The draft is written before external ticket-channel creation so a later Discord failure cannot erase an already-accepted response from durable storage. Ticket metadata carries only the form/submission identifiers needed for reconciliation; answers are not included in form-management audit details. The recovery worker links pending/failed submissions to their persisted ticket when the ticket is available.

## Historical scope boundary

At the time of this report, F-015 was the primary scope and conditional fields, templates, and Stage E were not yet included in that checkpoint. The current repository subsequently implements conditional multi-step forms and form templates, and Stage E now has a first custom multi-panel builder. Refer to `FEATURES.md` and `stages-a-to-e-audit.md` for the current status; the earlier checkpoint labels here are retained only to preserve implementation history.

## Verification checklist for the pull

1. Check GitHub Actions build, tests and database verification for this branch.
2. Pull the current reviewed feature branch into the Windows checkout and run the project's standard checks against a disposable/test PostgreSQL database, not production.
3. In a test server, create a form for a real existing department/tag, activate it, and create a ticket with every native field type.
4. Try a malformed/stale/expired form, invalid values, a wrong user/role, an untrusted or oversized attachment, a disabled form, and a form update while a modal is open.
5. Submit duplicate ticket requests from two workers if the deployment runs multiple replicas, then test unclaim/claim and the existing ticket lifecycle buttons.
6. Simulate database and Discord failures around draft persistence, channel creation, ticket registration, and submission attachment; verify that a ticket is preserved and a pending form response is recoverable.
7. Confirm no answer values appear in the general or developer audit-log details.

No command here claims the checks above passed. This branch is a code change set, not a substitute for that verification.
