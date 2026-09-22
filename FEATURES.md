# SupportForge — Master Features, Requirements & Long-Term Product Specification

**Project:** SupportForge  
**Repository:** `Annant2122011/supportforge`  
**Current Repository Version:** `2.0.0`  
**Primary Runtime:** Node.js + TypeScript + discord.js  
**Initial Product Surface:** Discord  
**Long-Term Product Surface:** Discord + Web Dashboard + API + AI + Integrations  
**Document Type:** Product specification / feature registry / implementation roadmap  
**Document Status:** Living document  

---

# 0. HOW TO USE THIS DOCUMENT

This file is the long-term memory of SupportForge.

It is intentionally much more detailed than an ordinary README. The goal is that development can stop for weeks or months and this document will still explain what the system is supposed to become, what has already been implemented, what remains incomplete, why a feature exists, what it depends on, and what “done” actually means.

This document is **not** an instruction to implement every feature immediately.

It is a roadmap and specification. A feature may be documented years before it is implemented.

Whenever possible, implementation should proceed in small, tested increments rather than one enormous rewrite. In particular, do not turn a currently working ticket interaction file into a giant file that contains tickets, billing, AI, analytics, webhooks, database code, and the emotional burden of modern software engineering all at once.

---

# 1. PRODUCT IDENTITY

## 1.1 What SupportForge Is

SupportForge is an advanced support and ticket-management platform initially delivered through Discord. It is intended to provide businesses, online communities, software projects, e-commerce operations, crypto communities, and similar organizations with a professional customer-support workflow inside Discord, eventually expanding into a full multi-tenant SaaS platform.

The Discord bot is the first interface and operational adapter. It should not become a permanent container for all business logic. Over time, the core support domain should be separated from Discord-specific code so that the same ticket, SLA, analytics, AI, and automation systems can serve Discord, a web dashboard, an API, and external integrations.

## 1.2 Product Vision

SupportForge should evolve through these stages:

```text
Discord Ticket Bot
        ↓
Advanced Support System
        ↓
Support Operations Platform
        ↓
AI-Assisted Support Platform
        ↓
Multi-Tenant SaaS
        ↓
Full Customer-Support Ecosystem
```

## 1.3 Primary Goals

1. Make professional support workflows possible inside Discord.
2. Reduce repetitive staff work.
3. Preserve complete ticket history and accountability.
4. Make support operations measurable.
5. Introduce automation without removing human control.
6. Add AI as an assistance layer, not as an uncontrolled authority.
7. Build toward a real SaaS architecture with isolated customer data.
8. Keep the architecture extensible enough that future features do not require rewriting the entire bot.

## 1.4 Non-Goals for the Initial Discord Release

The first stable Discord release does **not** need all of the following simultaneously:

- web dashboard
- real billing
- external database cluster
- custom 8B model
- full RAG system
- multi-provider AI orchestration
- dozens of external integrations
- white-label SaaS
- customer web portal

Those belong to later phases.

---

# 2. STATUS SYSTEM

Every feature in this document uses one of the following statuses.

| Status | Meaning |
|---|---|
| `BUILT` | Implemented in the current codebase and intended to work in the current product. |
| `PARTIAL` | Some pieces work, but the complete intended behavior is not yet present. |
| `PLANNED` | Clearly defined future feature with no complete implementation yet. |
| `INFRASTRUCTURE REQUIRED` | Requires backend, database, storage, third-party service, worker, or other infrastructure beyond the current Discord-only architecture. |
| `FUTURE` | Long-term feature which should be considered after the core platform is mature. |
| `OPTIONAL` | Useful enhancement that is not required for the primary product vision. |
| `DEPRECATED` | No longer part of the intended architecture and should not be implemented unless deliberately revisited. |

## 2.1 Priority System

| Priority | Meaning |
|---|---|
| `P0` | Core reliability. The product is not considered foundationally complete without it. |
| `P1` | Important professional Discord functionality. |
| `P2` | Advanced operational functionality. |
| `P3` | Backend, AI, and SaaS functionality. |
| `P4` | Enterprise and long-term expansion. |
| `P5` | Experimental or optional future functionality. |

---

# 3. ARCHITECTURAL PRINCIPLES

## 3.1 Discord Is an Adapter, Not the Whole Backend

The current bot naturally contains Discord-specific logic. The long-term architecture should separate:

```text
Discord Events / Interactions
            ↓
Application Services
            ↓
Domain Logic
            ↓
Repositories / Persistence
            ↓
External Infrastructure
```

Future web/API clients should call the same application services where practical.

## 3.2 Explicit Ticket State

Ticket state must be explicit.

The current intended states are:

```text
OPEN
CLAIMED
PENDING
CLOSED
REOPENED
ARCHIVED
```

A ticket must not be considered “closed” merely because a Discord permission overwrite happens to restrict the customer.

## 3.3 Deterministic Systems vs AI Systems

Deterministic actions should stay deterministic.

Examples:

- permission checks
- billing status
- subscription entitlements
- state transitions
- database writes
- audit events
- SLA arithmetic
- role authorization

AI may assist with:

- classification
- summaries
- suggested responses
- knowledge retrieval
- language translation
- routing recommendations

AI should not be allowed to bypass authorization rules simply because a model generated a confident sentence.

## 3.4 Configuration Over Hardcoding

Guild-specific configuration should eventually be stored in a persistent configuration system rather than being hardcoded in source files.

Examples:

- guild IDs
- category IDs
- transcript channel IDs
- audit channel IDs
- role IDs
- department IDs
- ticket limits
- SLA targets
- business hours
- plan entitlements
- branding

---

# 4. CURRENT SYSTEM FOUNDATION

The current repository already contains a meaningful Discord ticket engine. It should be treated as the existing foundation, not discarded during future development.

Known core areas include:

- Support Center panel
- ticket creation
- modal-based ticket creation
- departments
- private ticket channels
- permission management
- ticket lifecycle states
- duplicate-open-ticket prevention
- ticket claiming
- ticket reopening
- ticket closing
- HTML transcript generation
- transcript upload
- attachment handling in transcripts
- reply reference handling
- add/remove users
- ticket creation cooldown
- setup/configuration commands
- category management
- priorities
- tags
- internal staff notes
- audit logging

The exact implementation should always be checked against the actual repository before changing a feature from `PARTIAL` or `PLANNED` to `BUILT`.

---

# 5. CORE TICKETING

## F-001 — Support Center Panel

**Status:** `BUILT`  
**Priority:** `P0`

### Purpose

Provide a visible entry point where customers can start a support interaction.

### Current behavior

SupportForge can create a Support Center panel with ticket creation controls and department-related buttons.

### Required behavior

A user should be able to understand from the panel:

- how to request support
- what department to choose
- what will happen after clicking
- whether there are support rules or limits

### Future enhancements

- multiple panels per guild
- custom branding
- configurable buttons
- custom emojis
- department-specific panel text
- multiple ticket workflows
- panel versioning
- dashboard-based editing

### Dependencies

Discord bot, guild configuration, department configuration.

### Acceptance criteria

- Panel can be created reliably.
- Buttons use stable custom IDs.
- Buttons route to the correct department/workflow.
- Unauthorized configuration changes are blocked.
- Existing tickets are not affected by panel edits.

---

## F-002 — Custom Panel Builder

**Status:** `PLANNED`  
**Priority:** `P1`

### Purpose

Turn the generated Support Center into a true configurable panel builder rather than a mostly fixed bot-generated message.

### Configuration fields

A panel should eventually support:

- panel ID
- panel name
- display title
- description
- icon
- thumbnail
- hero/banner image
- footer
- color/theme
- button labels
- button emoji
- button style
- button order
- department/workflow target
- modal/form target
- optional confirmation message
- panel-level permissions
- panel channel
- panel message ID

### Example panel

```text
╔══════════════════════════════════════╗
║          CUSTOMER SUPPORT            ║
║                                      ║
║ Select the type of help you need.    ║
║                                      ║
║ 🛒 Orders       💳 Billing            ║
║ 🛠 Technical    📦 Delivery           ║
║ 🤝 Partnerships                      ║
╚══════════════════════════════════════╝
```

### Long-term dashboard behavior

The administrator should be able to create a panel without editing code.

### Data model requirements

Potential entities:

```text
Panel
PanelButton
PanelWorkflow
Department
Form
```

### Important rules

Changing a panel should not invalidate already-open tickets.

Deleting a panel must not delete tickets.

### Acceptance criteria

- Admin can create multiple panels.
- Admin can reorder controls.
- Each button maps to a known workflow.
- Invalid workflows are rejected.
- Panel configuration survives bot restarts.

---

## F-003 — Department System

**Status:** `BUILT / PARTIAL`  
**Priority:** `P0`

### Purpose

Allow organizations to separate tickets by support function.

### Example departments

```text
General Support
Billing
Technical Support
Sales
Refunds
Partnerships
Moderation
VIP Support
```

### Planned department properties

- department ID
- name
- description
- staff roles
- supervisor roles
- fallback roles
- ticket category
- panel visibility
- ticket form
- SLA policy
- business-hours policy
- assignment policy
- auto-close policy
- tags
- canned responses
- knowledge base scope
- AI routing configuration

### Acceptance criteria

A ticket opened for one department must enter that department's workflow and not accidentally expose the ticket to unrelated staff.

---

## F-004 — Ticket Creation

**Status:** `BUILT`  
**Priority:** `P0`

### Current base fields

- subject
- description

### Future additions

Custom forms should supplement rather than unnecessarily duplicate the basic creation flow.

### Creation sequence

Recommended long-term flow:

```text
User chooses department
        ↓
Form opens
        ↓
User submits fields
        ↓
Validate form
        ↓
Check ticket limits/cooldown
        ↓
Create ticket record
        ↓
Create Discord channel
        ↓
Apply permissions
        ↓
Set initial state
        ↓
Post ticket control panel
        ↓
Audit event
        ↓
Optional notification/assignment
```

### Failure requirements

If channel creation succeeds but persistence fails, or vice versa, the system must have a recovery path. This becomes especially important after a real database is introduced.

---

## F-005 — Ticket IDs and Numbering

**Status:** `PARTIAL`  
**Priority:** `P1`

### Goal

Separate human-readable ticket numbers from Discord channel names.

### Recommended long-term identifier

```text
SF-000001
SF-000002
SF-000003
```

### Channel example

```text
ticket-1024
billing-1024
```

### Rule

The canonical ticket ID should live in persistent ticket data and should not depend on the current Discord channel name.

---

# 6. TICKET LIFECYCLE

## F-006 — Explicit Ticket State

**Status:** `BUILT`  
**Priority:** `P0`

### Supported conceptual states

```text
OPEN
CLAIMED
PENDING
CLOSED
REOPENED
ARCHIVED
```

### State meanings

#### OPEN
Ticket has been created and is awaiting active staff handling.

#### CLAIMED
A staff member has taken responsibility for handling the ticket.

#### PENDING
Work is temporarily waiting for customer information, an external system, another team, or another condition.

#### CLOSED
The support interaction has been completed or otherwise intentionally ended.

#### REOPENED
A previously closed ticket has become active again.

#### ARCHIVED
A closed ticket is retained for historical purposes but is no longer an active support interaction.

### Rule

State changes must be explicit and auditable.

---

## F-007 — State Transition Rules

**Status:** `PARTIAL`  
**Priority:** `P0`

### Valid examples

```text
OPEN → CLAIMED
OPEN → CLOSED
CLAIMED → PENDING
CLAIMED → CLOSED
PENDING → OPEN
PENDING → CLOSED
CLOSED → REOPENED
REOPENED → CLAIMED
REOPENED → CLOSED
CLOSED → ARCHIVED
```

### Requirements

Each transition should define:

- allowed actors
- required permissions
- required conditions
- side effects
- audit event
- notification behavior
- rollback/recovery behavior where appropriate

### Example

```text
Customer
OPEN → CLAIMED       X

Agent
OPEN → CLAIMED       ✓

Supervisor
CLAIMED → CLOSED     ✓

Administrator
Administrative override according to policy
```

---

## F-008 — Duplicate Open Ticket Prevention

**Status:** `BUILT`  
**Priority:** `P0`

### Purpose

Prevent unnecessary duplicate active tickets.

### Rule

Duplicate prevention should inspect explicit ticket status and applicable ownership/customer/department rules.

The system should not decide that a ticket is open merely because of channel permissions.

### Future behavior

Potential configurable modes:

- one active ticket total
- one active ticket per department
- unlimited tickets
- staff override

---

## F-009 — Ticket Claiming

**Status:** `BUILT / PARTIAL`  
**Priority:** `P1`

### Required metadata

- assignee
- claimant
- claim timestamp
- department
- previous assignee
- reassignment reason if applicable

### Future UI

```text
Ticket #SF-1024
Status: CLAIMED
Assigned to: @Agent
Claimed at: 14:02
```

---

## F-010 — Reassignment

**Status:** `PLANNED`  
**Priority:** `P1`

### Features

- manual reassignment
- supervisor reassignment
- department transfer
- automatic assignment
- reassignment reason
- reassignment history

### Important rule

Changing assignee must not silently change ownership or access rules without logging it.

---

## F-011 — Advanced Assignment Engine

**Status:** `PLANNED`  
**Priority:** `P2`

### Round robin

```text
Agent A
Agent B
Agent C
Agent A
Agent B
...
```

### Workload based

Assign to the eligible agent with the smallest active workload.

### Skill based

```text
Payment problem → Billing team
API error → Technical team
Refund request → Billing/Refund team
```

### Availability based

Do not assign to agents marked unavailable according to future presence/availability rules.

### Priority-aware assignment

Critical tickets may be assigned to senior staff or an emergency queue.

### Requirements

Assignment must remain deterministic after the AI recommendation phase. AI can recommend a department or category, but actual permission and assignment logic must validate the result.

---

# 7. PRIORITY, TAGS & METADATA

## F-012 — Ticket Priority

**Status:** `BUILT / PREMIUM DEMO`  
**Priority:** `P1`

### Levels

```text
LOW
NORMAL
HIGH
URGENT
CRITICAL
```

### Effects that priority may eventually control

- queue position
- SLA target
- notification urgency
- assignment policy
- escalation
- dashboard filtering
- AI routing

### Rule

Priority should be data, not merely emoji in the channel name.

---

## F-013 — Ticket Tags

**Status:** `BUILT / PREMIUM DEMO`  
**Priority:** `P1`

### Examples

```text
refund
payment
technical
bug
vip
shipping
fraud-review
urgent
```

### Future tag capabilities

- manual tag management
- automatic tag rules
- AI-suggested tags
- tag-based routing
- tag-based analytics
- tag filtering
- tag-specific automation

---

## F-014 — Structured Ticket Metadata

**Status:** `PLANNED`  
**Priority:** `P1`

Tickets should eventually contain structured fields such as:

```text
Ticket ID
Guild ID
Customer ID
Department ID
Assignee ID
Status
Priority
Tags
Created At
Updated At
First Response At
Closed At
Reopened At
Archived At
SLA Deadline
SLA State
Form Response ID
Transcript ID
Merged-Into ID
Source
```

This becomes essential once the project moves into a real database.

---

# 8. FORMS

## F-015 — Advanced Ticket Forms

**Status:** `PLANNED`  
**Priority:** `P1`

### Supported future field types

- short text
- long text
- number
- decimal
- URL
- email
- date
- dropdown
- multi-select
- checkbox
- Discord user
- Discord role
- attachment

### Validation

Each field should be able to define:

- required/optional
- minimum length
- maximum length
- numeric range
- allowed choices
- regex/pattern where appropriate
- attachment size/type limitations

### Example

```text
Billing Support

Order ID:       [__________]
Payment Method: [ Visa ▼ ]
Amount:         [__________]
Problem:        [____________________________]
Attachment:     [ Upload ]
```

---

## F-016 — Conditional Form Fields

**Status:** `PLANNED`  
**Priority:** `P1`

### Purpose

Display fields only when relevant.

### Example

```text
Issue Type: Refund

→ Show:
Order ID
Purchase Date
Refund Reason
Payment Method
```

Another example:

```text
Payment Method: Cryptocurrency

→ Show:
Transaction Hash
Network
Wallet Address
```

### Long-term implementation concept

Forms should have a declarative schema containing fields, conditions, validation rules, and workflow destination.

---

## F-017 — Form Templates

**Status:** `FUTURE`  
**Priority:** `P2`

Admins should be able to save reusable form templates.

Example:

```text
Bug Report Form
Refund Request Form
Partnership Form
Account Recovery Form
```

---

# 9. TICKET CONTROLS

## F-018 — Add / Remove Ticket Users

**Status:** `BUILT`  
**Priority:** `P0`

### Requirements

- authorized staff can add users
- authorized staff can remove users
- every access change is logged
- owner access is preserved according to policy
- administrators retain emergency access

---

## F-019 — Ticket Lock

**Status:** `PARTIAL`  
**Priority:** `P1`

### Meaning

A lock restricts normal customer interaction while authorized staff retain access.

### Important architectural distinction

```text
Ticket State = CLOSED
```

is different from:

```text
Ticket Channel = LOCKED
```

Locking should never be the database substitute for ticket state.

---

## F-020 — Closing Reason Modal

**Status:** `PLANNED`  
**Priority:** `P1`

### Goal

Require or optionally collect a structured reason when a ticket is closed.

### Example reasons

```text
Resolved
Customer stopped responding
Duplicate
Refund completed
Invalid request
Escalated externally
Other
```

### Data

- reason ID
- reason label
- free-text explanation if enabled
- actor
- timestamp

### Department customization

Departments may have different closing reasons.

---

## F-021 — Ticket Reopen

**Status:** `BUILT / PARTIAL`  
**Priority:** `P1`

### Requirements

Reopening should:

- update state to `REOPENED`
- restore appropriate access
- preserve prior history
- audit the change
- optionally notify staff
- preserve the original closed event

---

## F-022 — Ticket Archive

**Status:** `BUILT / PARTIAL`  
**Priority:** `P1`

### Rules

Archive means “historical and inactive”, not “deleted”.

Archived records must remain searchable and auditable unless retention policy removes them later.

---

# 10. TRANSCRIPTS

## F-023 — HTML Transcripts

**Status:** `BUILT`  
**Priority:** `P0`

### Transcript content

The transcript system should preserve as much useful conversational context as practical, including:

- messages
- timestamps
- author information
- attachments
- embeds
- stickers
- replies
- message links
- ticket metadata
- warnings when message history limits are reached

### Current strength

The existing transcript implementation is already a substantial foundation and should be extended rather than casually replaced.

---

## F-024 — Transcript Storage

**Status:** `PARTIAL`  
**Priority:** `P2`

### Current approach

Transcripts can be generated and uploaded in Discord.

### Future storage

Use an abstraction around object storage.

Potential providers:

- Cloudflare R2
- Amazon S3
- Backblaze B2
- Supabase Storage

### Requirements

- secure access
- retention policy
- audit trail
- optional expiration
- tenant isolation
- no public exposure by default

---

## F-025 — Transcript Export Formats

**Status:** `PLANNED`  
**Priority:** `P2`

Future support may include:

- HTML
- JSON
- plain text
- PDF via a dedicated rendering service if justified

HTML should remain the canonical human-readable format unless requirements change.

---

# 11. AUDITING & HISTORY

## F-026 — Audit Log

**Status:** `BUILT / PREMIUM DEMO`  
**Priority:** `P1`

### Event types

At minimum:

```text
TICKET_CREATED
TICKET_CLAIMED
TICKET_ASSIGNED
TICKET_REASSIGNED
STATUS_CHANGED
PRIORITY_CHANGED
TAG_ADDED
TAG_REMOVED
USER_ADDED
USER_REMOVED
INTERNAL_NOTE_ADDED
TICKET_CLOSED
CLOSING_REASON_ADDED
TICKET_REOPENED
TICKET_MERGED
TICKET_ARCHIVED
TRANSCRIPT_GENERATED
TRANSCRIPT_STORED
SLA_WARNING
SLA_BREACH
AI_ACTION_SUGGESTED
AI_ACTION_APPROVED
```

### Event fields

Each event should eventually contain:

- event ID
- tenant/guild ID
- ticket ID
- actor ID
- event type
- timestamp
- previous state/value if relevant
- new state/value if relevant
- structured metadata

---

## F-027 — Ticket Event Timeline

**Status:** `PLANNED`  
**Priority:** `P1`

### Example

```text
09:31  Ticket created by customer
09:32  Assigned to Agent A
09:40  Priority changed NORMAL → HIGH
09:44  Internal note added
10:02  Status CLAIMED → PENDING
10:15  Status PENDING → OPEN
10:30  Reassigned to Agent B
11:05  Ticket closed
11:06  Transcript generated
```

### Interfaces

Potential future commands:

```text
/ticket history
/ticket events
```

and a web dashboard timeline.

---

# 12. STAFF PRODUCTIVITY

## F-028 — Canned / Saved Responses

**Status:** `PLANNED`  
**Priority:** `P1`

### Example

```text
/refund-policy
/payment-pending
/account-verification
/troubleshooting-login
```

### Variables

```text
Hello {user},

Your order #{order_id} is currently being reviewed.
```

### Future controls

- department-specific responses
- role permissions
- response search
- usage analytics
- version history

---

## F-029 — Staff Availability

**Status:** `PLANNED`  
**Priority:** `P2`

Future staff profiles may contain:

- available/unavailable
- department membership
- skills
- maximum active tickets
- current workload
- business hours
- vacation/leave status

This supports automatic assignment.

---

## F-030 — Workload Dashboard

**Status:** `PLANNED`  
**Priority:** `P2`

Show operational workload such as:

```text
Agent A: 4 active
Agent B: 11 active
Agent C: 2 active
```

Metrics must be interpreted carefully. Ticket volume alone does not mean equal difficulty or equal contribution.

---

# 13. TICKET MERGING

## F-031 — Ticket Merge

**Status:** `PLANNED`  
**Priority:** `P1`

### Purpose

Combine duplicate or related tickets without losing historical information.

### Example

```text
Ticket #1021
Ticket #1028
Ticket #1032
       ↓
Master Ticket #1021
```

### Requirements

Preserve:

- messages
- participants
- attachments
- forms
- tags
- events
- transcripts
- original ticket references

### Rules

Merged tickets should become historical records that point to the master ticket rather than simply vanishing.

---

# 14. AUTOMATION

## F-032 — Inactivity Auto-Close

**Status:** `PLANNED`  
**Priority:** `P1`

### Example

```text
Day 7:
No customer response → warning

Day 10:
Still inactive → auto-close
```

### Exemptions

Possible exemptions:

- Critical tickets
- VIP tickets
- staff-marked exemption
- active escalation
- certain departments

### Requirements

- warning before closure
- configurable thresholds
- audit event
- transcript generation before closure
- no duplicate automated actions

This likely requires a background worker for reliable production behavior.

---

## F-033 — Rule-Based Automation Engine

**Status:** `FUTURE`  
**Priority:** `P3`

### Example rule

```text
WHEN priority = CRITICAL
AND department = Billing
THEN
    assign to supervisor pool
    notify supervisor
    start critical SLA
```

### Rule components

```text
Trigger
Condition(s)
Action(s)
Execution limit
Audit policy
Failure policy
```

### Safety

Automation must validate actions against permissions and current state.

---

# 15. SLA & QUEUE MANAGEMENT

## F-034 — SLA System

**Status:** `PLANNED`  
**Priority:** `P2`

### SLA types

1. First response SLA
2. Claim SLA
3. Resolution SLA

### Example

```text
CRITICAL
First response: 5 min
Resolution: 2 hr

HIGH
First response: 30 min
Resolution: 8 hr

NORMAL
First response: 4 hr
Resolution: 48 hr
```

### Required data

- SLA policy ID
- start time
- pause time
- deadline
- elapsed active time
- warning threshold
- breached flag
- breach timestamp

---

## F-035 — SLA Pause / Resume

**Status:** `PLANNED`  
**Priority:** `P2`

Pending states may pause an SLA depending on policy.

Example:

```text
CLAIMED
  ↓
PENDING: waiting for customer
  ↓
OPEN
```

The system must define exactly which clocks pause and which remain active.

---

## F-036 — SLA Warnings and Escalation

**Status:** `PLANNED`  
**Priority:** `P2`

### Example

```text
80% elapsed → warning
100% elapsed → breach
```

Possible actions:

- notify assignee
- notify supervisor
- notify department manager
- increase priority
- reassign
- create escalation event

---

## F-037 — Business Hours

**Status:** `PLANNED`  
**Priority:** `P2`

SupportForge should understand support calendars.

Example:

```text
Monday-Friday: 09:00-18:00
Saturday:      10:00-14:00
Sunday:        Closed
```

Future configuration should support:

- timezone
- holidays
- department-specific hours
- emergency coverage
- temporary closures

---

## F-038 — Queue Management

**Status:** `PLANNED`  
**Priority:** `P2`

Queue ordering may consider:

1. priority
2. SLA urgency
3. creation time
4. customer tier
5. department rules
6. assignment constraints

The queue must remain understandable to staff.

---

# 16. CUSTOMER EXPERIENCE

## F-039 — Customer Satisfaction Ratings

**Status:** `PLANNED`  
**Priority:** `P2`

### Basic flow

```text
Ticket closed
    ↓
Customer receives rating prompt
    ↓
1–5 stars
    ↓
Optional written feedback
```

### Stored values

- ticket ID
- rating
- feedback
- timestamp
- department
- agent/assignment at closure

### Privacy

Rating data should not expose private customer information to unrelated staff.

---

## F-040 — Customer Notifications

**Status:** `PLANNED`  
**Priority:** `P1`

Potential notifications:

- ticket created
- ticket assigned
- staff reply
- ticket pending
- ticket reopened
- ticket closed
- SLA-related customer notification when configured
- rating request

Discord is the primary initial channel. Web/email/push may come later.

---

## F-041 — Customer Portal

**Status:** `FUTURE`  
**Priority:** `P4`

A web portal may allow customers to:

- see open tickets
- reply
- upload files
- see ticket state
- view past support interactions
- rate tickets

This is not required for initial Discord product-market validation.

---

# 17. STAFF ANALYTICS

## F-042 — Staff Performance Analytics

**Status:** `PLANNED`  
**Priority:** `P2`

Potential metrics:

- tickets handled
- first response time
- resolution time
- SLA compliance
- reopen rate
- backlog
- customer satisfaction
- active workload

### Important interpretation rule

Metrics should be treated as operational signals, not as simplistic rankings. A staff member who handles fewer tickets may be dealing with unusually complex work.

---

## F-043 — Department Analytics

**Status:** `PLANNED`  
**Priority:** `P2`

Possible reports:

- tickets per day/week/month
- average response time
- average resolution time
- SLA breaches
- ticket source
- priority distribution
- tag distribution
- satisfaction
- reopening rate
- backlog

---

## F-044 — Trend Analytics

**Status:** `FUTURE`  
**Priority:** `P3`

Identify recurring operational issues such as:

- payment incidents increasing
- a particular product producing more tickets
- repeated bugs
- rising SLA breaches
- repeated customer confusion around one policy

This should eventually connect to knowledge-base recommendations.

---

# 18. VOICE ESCALATION

## F-045 — Voice-Channel Escalation

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P2`

### Goal

Allow staff to escalate a text ticket into a temporary voice support session.

### Basic flow

```text
Ticket #SF-1052
     ↓
Escalate to Voice
     ↓
Create restricted voice channel
     ↓
Customer + authorized staff join
     ↓
Session ends
     ↓
Record escalation event
```

### Future metadata

- voice channel ID
- start time
- end time
- participants
- escalation reason
- ticket ID

### Advanced future option

Voice transcription and AI summary may be added later, subject to privacy, legal, and technical requirements.

---

# 19. AI SUPPORT PLATFORM

## F-046 — AI Service Layer

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

AI should be exposed through a service abstraction.

Concept:

```text
Discord Bot
     ↓
SupportForge Application Layer
     ↓
AI Service Interface
     ↓
Selected Model Provider
```

Possible model backends:

- external API provider
- self-hosted model
- local model
- custom SupportForge model

The bot should not contain provider-specific AI logic everywhere.

---

## F-047 — AI Ticket Summaries

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

### Example output

```text
Customer is unable to complete payment.

Attempts:
- Visa
- UPI

Current issue:
Payment authorization fails.

Suggested next action:
Ask customer to retry using another supported method.
```

### Requirements

- summary should include relevant ticket context
- summary should not invent facts
- summary should identify uncertainty
- summary generation should be auditable
- summaries should never replace source messages as the authoritative record

---

## F-048 — AI Suggested Replies

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

### Principle

```text
AI suggests.
Human reviews.
Human sends.
```

### Inputs

- conversation
- ticket state
- department
- customer information allowed by policy
- knowledge base
- previous support context

### Controls

- regenerate
- shorten
- make more formal
- translate
- show sources used
- copy to reply box

---

## F-049 — AI Ticket Classification

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

Classify tickets into structured fields.

Example:

```text
Input:
"I was charged twice for the same order."

Output:
Department: Billing
Priority suggestion: High
Tags: duplicate-payment
Intent: duplicate-charge
```

The backend must validate AI outputs before writing them to authoritative ticket state.

---

## F-050 — AI Smart Routing

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

AI may recommend:

- department
- priority
- tags
- staff skill group
- escalation path

The deterministic routing engine performs the final authorized action.

---

## F-051 — AI Sentiment / Frustration Signals

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

Possible operational signals:

```text
Neutral
Frustrated
Escalation risk
Urgent language
```

These are signals for support operations, not definitive judgments about a person's mental state.

---

## F-052 — AI Translation

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

Capabilities:

- language detection
- translation of customer messages
- translation of suggested replies
- multilingual knowledge retrieval

The original message should remain available so translations do not replace source material.

---

# 20. KNOWLEDGE BASE & RAG

## F-053 — Knowledge Base

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

Sources may include:

- FAQs
- product documentation
- troubleshooting guides
- policy documents
- internal support manuals
- help articles

### Structure

```text
Knowledge Base
├── Billing
│   ├── Refunds
│   ├── Failed Payments
│   └── Chargebacks
├── Technical
│   ├── Login
│   ├── API
│   └── Troubleshooting
└── General
    └── Account Help
```

---

## F-054 — Knowledge Base Search

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

Search should support both:

- keyword search
- semantic search

Search results should expose source references where practical.

---

## F-055 — RAG Pipeline

**Status:** `FUTURE / INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

Concept:

```text
User Question
      ↓
Query Processing
      ↓
Retrieve Relevant Documents
      ↓
Context Assembly
      ↓
Model
      ↓
Answer / Suggestion
```

The retrieved content should be tenant-scoped.

A guild must never retrieve another guild's private knowledge.

---

## F-056 — Knowledge Ingestion Pipeline

**Status:** `FUTURE`  
**Priority:** `P3`

Possible pipeline:

```text
Document
   ↓
Parser
   ↓
Text Cleaner
   ↓
Chunker
   ↓
Metadata
   ↓
Embedding
   ↓
Vector Store
```

Supported future source types:

- Markdown
- HTML
- PDF
- TXT
- web pages
- support articles

---

## F-057 — Vector Database

**Status:** `FUTURE / INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

Potential technologies:

- pgvector
- Qdrant
- Pinecone
- Weaviate
- Cloudflare Vectorize

Do not choose a vendor merely because it appears popular today. The selection should be made after the production data architecture is known.

---

# 21. CUSTOM SUPPORTFORGE 8B MODEL

## F-058 — Custom SupportForge 8B-Class Model

**Status:** `FUTURE / INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

### Purpose

Develop a specialized model for SupportForge support workflows.

### Potential capabilities

- support conversation summarization
- ticket classification
- suggested replies
- department classification
- response style adaptation
- extraction of structured ticket information
- knowledge-grounded assistance

### Important architecture rule

The model is an intelligence component. It is not the authoritative database, permission system, billing system, or ticket-state engine.

### Long-term architecture

```text
SupportForge Backend
        ↓
AI Gateway
        ↓
SupportForge Model
        ↓
RAG / Tools / Policies
```

---

## F-059 — Custom Model Training Pipeline

**Status:** `FUTURE / INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

Possible stages:

```text
Data Collection
      ↓
PII / Sensitive Data Filtering
      ↓
Cleaning
      ↓
Deduplication
      ↓
Instruction Formatting
      ↓
Fine-Tuning / Training
      ↓
Evaluation
      ↓
Safety Tests
      ↓
Deployment
      ↓
Monitoring
```

### Critical rule

Customer support conversations must not automatically become training data.

Training data must be intentionally selected and appropriately handled.

---

## F-060 — AI Evaluation Suite

**Status:** `FUTURE`  
**Priority:** `P3`

The custom model should be tested against representative tasks.

Metrics may include:

- classification accuracy
- groundedness
- hallucination rate
- response correctness
- refusal behavior
- formatting compliance
- latency
- token/cost efficiency

Model quality should be measured against a fixed evaluation set rather than judged by a few impressive examples.

---

# 22. DATABASE & PERSISTENCE

## F-061 — Production Database

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P2/P3`

The current local configuration approach is appropriate for early development but is not sufficient as the long-term authoritative data layer for a commercial multi-tenant platform.

### Potential technologies

- PostgreSQL
- SQLite for smaller deployments
- Cloudflare D1
- Supabase/Postgres

### Core future entities

```text
Guild / Tenant
User
Staff Profile
Department
Panel
Panel Button
Form
Form Field
Ticket
Ticket Message Metadata
Ticket Event
Assignment
Priority
Tag
Internal Note
Transcript
SLA Policy
SLA Instance
Business Hours
Canned Response
Knowledge Article
Subscription
Feature Entitlement
Integration
API Key
Webhook
AI Request
```

---

## F-062 — Multi-Tenant Data Isolation

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P2`

Every persistent object that belongs to a customer organization should be scoped to that tenant.

Concept:

```text
Tenant A
  ├── Tickets
  ├── Staff
  ├── Panels
  └── Knowledge

Tenant B
  ├── Tickets
  ├── Staff
  ├── Panels
  └── Knowledge
```

### Requirement

A bug in one query must not be able to return another tenant's records.

Tenant scoping should be enforced in repository/service layers, not only in UI filters.

---

## F-063 — Database Migrations

**Status:** `PLANNED`  
**Priority:** `P2`

Production schema changes must use migrations.

Example:

```text
001_create_guilds
002_create_tickets
003_create_ticket_events
004_create_sla
005_create_subscriptions
```

Never rely on manually editing a production database as the standard deployment method.

---

## F-064 — Data Backups

**Status:** `PLANNED`  
**Priority:** `P2`

Backups should cover:

- database
- configuration
- transcripts/object storage metadata
- knowledge base

Backups must be tested through restoration drills.

---

# 23. MULTI-TENANT SAAS

## F-065 — Tenant Management

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

Each Discord guild should map to a tenant.

Future tenant object:

```text
Tenant
├── Discord Guild
├── Subscription
├── Entitlements
├── Settings
├── Users
├── Tickets
├── Integrations
└── Knowledge Base
```

---

## F-066 — Tenant Onboarding

**Status:** `FUTURE`  
**Priority:** `P3`

Future flow:

```text
Login
 ↓
Connect Discord
 ↓
Choose Guild
 ↓
Authorize SupportForge
 ↓
Create Default Configuration
 ↓
Setup Wizard
 ↓
Ready
```

---

## F-067 — Subscription Entitlements

**Status:** `PARTIAL / DEMO-BASED`  
**Priority:** `P3`

Current tiers should be considered development/demo switches rather than a real commercial entitlement system.

Long-term tiers may include:

```text
Free
Premium
Pro
Enterprise
```

Entitlements should be checked centrally.

---

# 24. WEB DASHBOARD

## F-068 — Web Dashboard

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

### Main areas

```text
Dashboard
Tickets
Departments
Staff
Panels
Forms
Canned Responses
SLA
Analytics
Automation
Knowledge Base
AI
Integrations
Billing
Settings
```

### Goal

Users should be able to configure SupportForge without manually editing JSON or source code.

---

## F-069 — Web Ticket View

**Status:** `FUTURE`  
**Priority:** `P3`

The web ticket page should show:

- conversation
- customer
- status
- priority
- assignee
- department
- tags
- SLA
- timeline
- internal notes
- AI summary
- suggested replies
- transcript

---

## F-070 — Authentication

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

Potential methods:

- Discord OAuth
- email/password
- Google or another OAuth provider

Discord OAuth is the most natural initial method because SupportForge is Discord-centric.

Authentication must be tied to tenant membership and permissions.

---

## F-071 — Web RBAC

**Status:** `PLANNED`  
**Priority:** `P2/P3`

Future roles may include:

```text
Owner
Administrator
Manager
Supervisor
Senior Agent
Agent
Trainee
Viewer
```

Potential permissions:

```text
ticket.view
ticket.reply
ticket.claim
ticket.assign
ticket.close
ticket.reopen
ticket.merge
ticket.archive
ticket.export
analytics.view
settings.manage
staff.manage
billing.manage
ai.manage
integrations.manage
```

The web permission model should align with Discord permissions where appropriate but should not blindly assume they are identical.

---

# 25. API

## F-072 — Internal Backend API

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P2/P3`

The backend API should eventually become the shared interface between clients and core services.

Possible structure:

```text
Discord Bot → Backend API
Web Dashboard → Backend API
External Client → Public API
Workers → Backend Services
```

---

## F-073 — Public API

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

Potential endpoints:

```text
GET    /api/v1/tickets
GET    /api/v1/tickets/:id
POST   /api/v1/tickets
PATCH  /api/v1/tickets/:id
POST   /api/v1/tickets/:id/assign
POST   /api/v1/tickets/:id/close
POST   /api/v1/tickets/:id/reopen
GET    /api/v1/analytics
GET    /api/v1/knowledge/articles
```

### Requirements

- authentication
- authorization
- tenant isolation
- rate limiting
- validation
- auditability
- versioning

---

## F-074 — API Versioning

**Status:** `PLANNED`  
**Priority:** `P3`

Use versioned APIs:

```text
/api/v1/...
/api/v2/...
```

Breaking changes should not silently break customer integrations.

---

# 26. WEBHOOKS & INTEGRATIONS

## F-075 — Outgoing Webhooks

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

Possible events:

```text
ticket.created
ticket.closed
ticket.reopened
ticket.assigned
ticket.priority_changed
ticket.tag_changed
sla.warning
sla.breached
rating.received
```

### Security

Outgoing webhook requests should eventually support:

- signatures
- timestamps
- secret rotation
- replay protection
- retry policy

---

## F-076 — Incoming Webhooks

**Status:** `FUTURE`  
**Priority:** `P4`

Potential use cases:

- external incident creates ticket
- payment system reports event
- GitHub comment updates support record
- monitoring service opens support/incident ticket

Authentication is mandatory.

---

## F-077 — Third-Party Integrations

**Status:** `FUTURE / INFRASTRUCTURE REQUIRED`  
**Priority:** `P4`

Potential integrations:

- Slack
- GitHub
- Notion
- Shopify
- CRM systems
- email providers
- monitoring/alerting tools
- external help desks

Integrations should be modular and independently enabled.

---

## F-078 — GitHub Integration

**Status:** `FUTURE`  
**Priority:** `P4`

Possible workflow:

```text
Support Ticket
      ↓
Create GitHub Issue
      ↓
Track Issue
      ↓
Sync relevant status/comments
```

Useful for technical support and bug reporting.

---

## F-079 — E-Commerce Integrations

**Status:** `FUTURE`  
**Priority:** `P4`

Potential future capabilities:

- retrieve order status
- match customer/order IDs
- show shipping state
- attach order context to tickets
- route based on product/order issue

Sensitive data should only be exposed to authorized staff.

---

# 27. BILLING & COMMERCIALIZATION

## F-080 — Real Subscription Billing

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

Current premium/demo flags are not equivalent to real billing.

A production system will require server-side subscription state.

Possible provider:

- Stripe

### Required flows

- checkout
- activation
- upgrade
- downgrade
- cancellation
- renewal
- failed payment
- grace period
- invoice history

---

## F-081 — Plan Entitlements

**Status:** `PLANNED`  
**Priority:** `P3`

Example structure:

```text
FREE
- basic tickets
- basic departments

PREMIUM
- priority
- tags
- internal notes
- advanced customization

PRO
- SLA
- analytics
- assignment automation
- advanced support tools

ENTERPRISE
- API
- integrations
- white-labeling
- advanced AI
```

Exact plans and limits should be decided later based on actual product strategy.

---

# 28. WHITE LABEL / ENTERPRISE

## F-082 — White-Label Branding

**Status:** `INFRASTRUCTURE REQUIRED`  
**Priority:** `P4`

Enterprise customers may eventually customize:

- product name
- logo
- colors
- dashboard theme
- support URL
- email templates
- panel branding

---

## F-083 — Enterprise Controls

**Status:** `FUTURE`  
**Priority:** `P4`

Potential enterprise capabilities:

- organization hierarchy
- multiple teams
- advanced audit export
- SSO
- custom retention
- dedicated infrastructure
- custom AI controls
- advanced API limits

---

# 29. CONFIGURATION & ADMINISTRATION

## F-084 — Setup Command

**Status:** `BUILT`  
**Priority:** `P0`

The setup process should create or repair required Discord infrastructure.

Potential resources:

- SupportForge category
- support panel
- transcript channel
- audit channel

### Future behavior

Setup should become idempotent and diagnostic.

Running setup multiple times should not create uncontrolled duplicates.

---

## F-085 — Setup Diagnostics

**Status:** `PLANNED`  
**Priority:** `P1`

Possible command:

```text
/supportforge diagnose
```

Checks:

```text
Bot online                  ✓
Required permissions        ✓
Category exists             ✓
Panel exists                ✓
Transcript channel          ✓
Audit channel               ✓
Roles valid                 ✓
Configuration valid         ✓
Database reachable          ✓
Storage reachable           ✓
AI service reachable        ✓
```

Where possible, diagnostics should explain how to fix failures.

---

## F-086 — Configuration Validation Report

**Status:** `PLANNED`  
**Priority:** `P1`

Detect:

- missing role IDs
- missing channel IDs
- invalid category IDs
- conflicting settings
- unsupported features
- incomplete department definitions
- broken integration credentials
- inconsistent entitlement configuration

---

## F-087 — Configuration Versioning

**Status:** `FUTURE`  
**Priority:** `P3`

Important configuration changes should be versioned.

Example:

```text
Version 12
SLA Normal changed from 24h → 12h
Changed by Administrator
Timestamp 2026-09-22
```

Rollback should eventually be possible.

---

# 30. SECURITY

## F-088 — Permission Security

**Status:** `ONGOING`  
**Priority:** `P0`

Security must cover:

- Discord permission checks
- ticket ownership
- staff role authorization
- administrator overrides
- web RBAC
- API permissions
- tenant isolation

---

## F-089 — Secret Management

**Status:** `ONGOING`  
**Priority:** `P0`

Never commit secrets such as:

- Discord token
- database password
- AI API key
- payment provider secret
- OAuth client secret
- webhook signing secret

Use environment variables or a dedicated secret-management system.

---

## F-090 — Rate Limiting

**Status:** `PLANNED`  
**Priority:** `P2`

Potential limits:

- tickets per user
- interactions per user
- tickets per guild
- API requests per key
- webhook requests
- AI requests

Limits should be configurable by plan and abuse risk.

---

## F-091 — Abuse / Spam Protection

**Status:** `PLANNED`  
**Priority:** `P2`

Possible protections:

- ticket creation cooldown
- maximum open tickets
- repeated request detection
- attachment limits
- IP rate limiting for web services
- API throttling

Existing creation cooldown should eventually be configurable per tenant.

---

# 31. OBSERVABILITY & RELIABILITY

## F-092 — Structured Logging

**Status:** `PLANNED`  
**Priority:** `P2`

Production logs should contain useful structured metadata such as:

- timestamp
- severity
- tenant/guild ID
- ticket ID
- actor ID
- event
- correlation ID
- error code

Avoid dumping full private ticket content into production logs unnecessarily.

---

## F-093 — Error Tracking

**Status:** `PLANNED`  
**Priority:** `P2`

Potential solutions:

- Sentry
- OpenTelemetry-based stack
- hosting provider logging

Errors should be grouped and traceable back to request/ticket context.

---

## F-094 — Health Checks

**Status:** `PLANNED`  
**Priority:** `P2`

A health endpoint or admin diagnostic system should report:

```text
Bot: ONLINE
Database: CONNECTED
Storage: CONNECTED
Queue: HEALTHY
AI: AVAILABLE
```

Health checks should distinguish “process alive” from “system actually functioning”.

---

## F-095 — Background Worker

**Status:** `FUTURE / INFRASTRUCTURE REQUIRED`  
**Priority:** `P2`

Long-running or scheduled tasks should move out of the Discord interaction path.

Examples:

- auto-close
- SLA monitoring
- analytics aggregation
- transcript processing
- AI summarization
- knowledge ingestion
- notifications

---

## F-096 — Job Queue

**Status:** `FUTURE / INFRASTRUCTURE REQUIRED`  
**Priority:** `P3`

Example:

```text
Ticket Closed
      ↓
Queue
 ├── Generate Transcript
 ├── Update Analytics
 ├── Generate AI Summary
 └── Send Notification
```

Potential technologies:

- Redis
- BullMQ
- cloud queue services

---

# 32. TESTING

## F-097 — Unit Tests

**Status:** `PLANNED`  
**Priority:** `P1`

Test:

- state transitions
- permission rules
- duplicate detection
- ticket-number generation
- form validation
- SLA arithmetic
- tag logic
- assignment logic
- entitlement checks

---

## F-098 — Integration Tests

**Status:** `PLANNED`  
**Priority:** `P1`

Test interactions between services such as:

```text
Ticket Service
     ↓
Audit Service
     ↓
Transcript Service
```

and, later:

```text
Backend
 ↓
Database
 ↓
Worker
```

---

## F-099 — Discord Interaction Tests

**Status:** `PLANNED`  
**Priority:** `P1`

Test:

- buttons
- modals
- slash commands
- permissions
- error responses
- state updates

---

## F-100 — Regression Suite

**Status:** `PLANNED`  
**Priority:** `P1`

Critical workflows should have automated regression tests.

Minimum examples:

```text
Create ticket
→ Claim
→ Pending
→ Reopen/Open
→ Close
→ Transcript
→ Archive
```

Also test:

```text
Duplicate ticket attempt
Unauthorized close
Unauthorized assignment
Missing permission
Missing configuration
Transcript failure
```

---

# 33. SEARCH & DISCOVERY

## F-101 — Ticket Search

**Status:** `PLANNED`  
**Priority:** `P2`

Filters should eventually include:

- ticket ID
- customer
- Discord user
- department
- status
- priority
- tag
- assignee
- date range
- closing reason

---

## F-102 — Message Search

**Status:** `FUTURE`  
**Priority:** `P3`

Search may include ticket message content where storage policy permits.

The search index must remain tenant-scoped.

---

## F-103 — Natural-Language Search

**Status:** `FUTURE / AI`  
**Priority:** `P4`

Example:

```text
Show tickets from last month where customers reported duplicate payments.
```

The AI should translate natural language into a constrained search operation rather than receiving unrestricted database access.

---

# 34. DATA & PRIVACY

## F-104 — Data Retention

**Status:** `PLANNED`  
**Priority:** `P2`

Configurable retention may apply to:

- active ticket records
- archived tickets
- transcripts
- audit logs
- AI logs
- attachments

Example:

```text
Transcripts: 365 days
Audit logs: 730 days
Archived tickets: 2 years
```

These are examples, not mandatory final values.

---

## F-105 — Data Export

**Status:** `FUTURE`  
**Priority:** `P3`

Tenant administrators may eventually export their data.

Possible formats:

- JSON
- CSV
- HTML transcripts

Exports must respect access permissions.

---

## F-106 — Data Deletion

**Status:** `FUTURE`  
**Priority:** `P3`

Provide controlled deletion procedures for:

- tickets
- customer records where applicable
- transcripts
- knowledge articles
- integrations

Deletion workflows must consider legal/retention constraints and audit requirements.

---

# 35. DEPLOYMENT & OPERATIONS

## F-107 — Production Deployment Separation

**Status:** `PARTIAL`  
**Priority:** `P2`

As the platform grows, deployment may separate into:

```text
Discord Bot
Backend API
Worker
Database
Object Storage
AI Service
Web Dashboard
```

Not all components must live on separate machines. The logical separation matters first.

---

## F-108 — Deployment Environments

**Status:** `PLANNED`  
**Priority:** `P2`

Suggested environments:

```text
development
staging
production
```

Production should not be the only place where schema changes and major feature combinations are tested.

---

## F-109 — Release Channels

**Status:** `OPTIONAL`  
**Priority:** `P5`

Potential future channels:

```text
Development
Beta
Stable
```

Enterprise customers may eventually receive controlled release schedules.

---

# 36. DOCUMENTATION SYSTEM

## F-110 — Product Documentation

**Status:** `ONGOING`  
**Priority:** `P1`

Recommended repository documentation:

```text
README.md
FEATURES.md
ARCHITECTURE.md
API.md
DATABASE.md
AI.md
DEPLOYMENT.md
SECURITY.md
CONTRIBUTING.md
```

### Responsibility of each file

`README.md`  
What the project is and how to run it.

`FEATURES.md`  
What the product contains and what is planned.

`ARCHITECTURE.md`  
How the system is technically structured.

`API.md`  
API contracts and usage.

`DATABASE.md`  
Schema and persistence design.

`AI.md`  
AI architecture, models, RAG, evaluation, and safety.

`DEPLOYMENT.md`  
Deployment procedures.

`SECURITY.md`  
Security requirements and threat considerations.

---

# 37. ARCHITECTURAL REFACTORING TARGET

The current project has Discord interaction and command logic concentrated in source files appropriate for an early-stage implementation.

As features increase, avoid allowing the same files to become permanent “everything files”.

## Preferred long-term conceptual structure

```text
src/
├── commands/
├── interactions/
├── services/
├── domain/
├── repositories/
├── infrastructure/
├── ai/
├── workers/
├── integrations/
├── config/
└── utils/
```

The exact folder structure can change.

The architectural separation should remain.

---

# 38. DOMAIN SERVICES THAT SHOULD EVENTUALLY EXIST

Potential service boundaries:

```text
TicketService
TicketStateService
TicketAssignmentService
TicketFormService
TicketMergeService
TicketTimelineService
PriorityService
TagService
TranscriptService
AuditLogService
SLAService
NotificationService
AutomationService
AnalyticsService
EntitlementService
BillingService
KnowledgeBaseService
SearchService
AIService
IntegrationService
```

Not every service needs to be its own package. These are domain responsibilities, not an instruction to create hundreds of files for the sheer joy of architecture diagrams.

---

# 39. API / SERVICE BOUNDARY RULES

The long-term system should follow these rules:

1. Discord event handlers should validate interaction input and delegate work.
2. Business rules should live in services/domain modules.
3. Persistence should be abstracted from business logic where practical.
4. External providers should be isolated behind adapters.
5. AI providers should be abstracted behind a stable interface.
6. Authorization should happen server-side.
7. Audit events should be emitted by important state-changing operations.

---

# 40. AI TOOL-ACTION SECURITY MODEL

AI should use bounded tools, not unrestricted system access.

Possible tool categories:

```text
READ_TICKET
SEARCH_KNOWLEDGE
SUGGEST_REPLY
CLASSIFY_TICKET
SUGGEST_TAGS
SUGGEST_PRIORITY
REQUEST_ASSIGNMENT
```

Sensitive execution should require deterministic authorization and, where appropriate, human approval.

Potential levels:

```text
READ
SUGGEST
REQUEST
APPROVE
EXECUTE
```

---

# 41. FAILURE / RECOVERY REQUIREMENTS

Every production feature must define what happens when an external dependency fails.

## Example: transcript failure

Do not mark the ticket as fully closed if policy requires the transcript to be generated first and transcript generation has failed.

## Example: database unavailable

The system must avoid silently claiming a state-changing operation succeeded when persistence did not complete.

## Example: Discord unavailable

Queue/retry logic may be needed in backend architectures.

## Example: AI unavailable

Core ticket support must continue to function without AI.

This is a critical design rule:

```text
AI failure must not equal ticket-system failure.
```

---

# 42. FEATURE DEPENDENCY MAP

The intended dependency progression is approximately:

```text
Basic Ticketing
      ↓
Ticket State
      ↓
Audit / Timeline
      ↓
Advanced Forms
      ↓
Automation
      ↓
Assignment
      ↓
SLA
      ↓
Analytics
      ↓
Persistent Database
      ↓
Backend API
      ↓
Web Dashboard
      ↓
Knowledge Base
      ↓
AI Layer
      ↓
RAG
      ↓
Custom SupportForge Model
      ↓
Commercial SaaS
```

Some features can be developed in parallel, but the architecture should respect these dependencies.

---

# 43. DEVELOPMENT PHASE ROADMAP

## PHASE 1 — COMPLETE THE DISCORD ENGINE

**Goal:** Professional and reliable Discord support bot.

### Target features

```text
Custom Panel Builder
Advanced Ticket Forms
Conditional Forms
Closing Reasons
Ticket Timeline
Canned Responses
Auto-Close
Ticket Merge
Advanced RBAC
Setup Diagnostics
Configuration Validation
Automated Tests
```

### Exit criteria

A normal business should be able to configure SupportForge entirely from Discord without editing source files, and the core ticket workflow should be testable and predictable.

---

## PHASE 2 — SUPPORT OPERATIONS

**Goal:** Make support teams measurable and manageable.

### Target features

```text
SLA
Business Hours
Assignment Engine
Queue Management
Customer Ratings
Staff Analytics
Department Analytics
Notification System
Voice Escalation
```

### Exit criteria

A support manager should be able to understand backlog, response performance, assignments, escalation, and customer satisfaction.

---

## PHASE 3 — BACKEND PLATFORM

**Goal:** Stop relying on Discord/local state as the only data architecture.

### Target features

```text
Production Database
Tenant Isolation
Backend API
Repositories
Migrations
Workers
Job Queue
Object Storage
Observability
Authentication
```

### Exit criteria

SupportForge should be able to operate as a persistent backend service independently of a single bot process.

---

## PHASE 4 — AI SUPPORT PLATFORM

**Goal:** Add useful, controlled intelligence.

### Target features

```text
AI Gateway
Ticket Summaries
Suggested Replies
Classification
Smart Routing
Translation
Knowledge Base
Semantic Search
RAG
AI Evaluation
Custom 8B Model Integration
```

### Exit criteria

AI should improve support operations without becoming a single point of failure or an uncontrolled authority.

---

## PHASE 5 — COMMERCIAL SAAS

**Goal:** Convert the platform into a multi-tenant commercial product.

### Target features

```text
Web Dashboard
Discord OAuth
Subscriptions
Billing
Entitlements
Public API
Webhooks
Integrations
White Label
Customer Portal
Enterprise Controls
```

### Exit criteria

An external business should be able to sign up, connect Discord, configure SupportForge, select a plan, and operate support without developer intervention.

---

# 44. PRIORITY MATRIX

| Feature | Priority | Status | Major Dependency |
|---|---:|---|---|
| Basic ticket creation | P0 | BUILT | Discord |
| Department tickets | P0 | BUILT/PARTIAL | Discord/config |
| Explicit ticket state | P0 | BUILT | Discord |
| Duplicate prevention | P0 | BUILT | Ticket state |
| Ticket permissions | P0 | BUILT/PARTIAL | Discord roles |
| Transcripts | P0 | BUILT | Discord |
| Audit logging | P1 | BUILT/PREMIUM DEMO | Discord |
| Priorities | P1 | BUILT/PREMIUM DEMO | Ticket metadata |
| Tags | P1 | BUILT/PREMIUM DEMO | Ticket metadata |
| Internal notes | P1 | BUILT/PREMIUM DEMO | Audit |
| Custom panels | P1 | PLANNED | Panel schema |
| Advanced forms | P1 | PLANNED | Form schema |
| Conditional forms | P1 | PLANNED | Form engine |
| Closing reasons | P1 | PLANNED | Ticket close |
| Timeline | P1 | PLANNED | Audit events |
| Canned responses | P1 | PLANNED | Message UI |
| Auto-close | P1 | PLANNED | Worker/scheduler |
| Ticket merge | P1 | PLANNED | Persistent IDs |
| Better RBAC | P1 | PLANNED | Permission model |
| Diagnostics | P1 | PLANNED | Configuration |
| Automated tests | P1 | PLANNED | Test stack |
| SLA | P2 | PLANNED | Worker + database |
| Assignment engine | P2 | PLANNED | Staff metadata |
| Business hours | P2 | PLANNED | SLA/calendar |
| Queue system | P2 | PLANNED | Assignment |
| Customer ratings | P2 | PLANNED | Persistent data |
| Staff analytics | P2 | PLANNED | Event data |
| Voice escalation | P2 | INFRASTRUCTURE REQUIRED | Discord voice |
| Production database | P2/P3 | INFRASTRUCTURE REQUIRED | Backend |
| Multi-tenant backend | P3 | INFRASTRUCTURE REQUIRED | Database/API |
| Web dashboard | P3 | INFRASTRUCTURE REQUIRED | Backend/auth |
| AI service | P3 | INFRASTRUCTURE REQUIRED | Backend/provider |
| Knowledge base | P3 | INFRASTRUCTURE REQUIRED | Storage/search |
| RAG | P3 | FUTURE | Vector/search |
| Custom 8B model | P3 | FUTURE | AI infrastructure |
| Billing | P3 | INFRASTRUCTURE REQUIRED | Payment provider |
| Public API | P3 | INFRASTRUCTURE REQUIRED | Auth/backend |
| Webhooks | P3 | INFRASTRUCTURE REQUIRED | API/events |
| Integrations | P4 | FUTURE | API |
| White labeling | P4 | INFRASTRUCTURE REQUIRED | SaaS |
| Customer portal | P4 | FUTURE | Web backend |

---

# 45. CURRENTLY BUILT FOUNDATION CHECKLIST

The following items are known to exist in the present project foundation and should be preserved unless a deliberate architecture change is made:

```text
[✓] Support Center panel
[✓] Ticket creation
[✓] Modal-based ticket creation
[✓] Department support
[✓] Private ticket channels
[✓] Ticket owner permissions
[✓] Staff permissions
[✓] Ticket lifecycle concept
[✓] Explicit status in channel topic
[✓] Duplicate-open prevention based on status
[✓] Ticket claiming
[✓] Ticket closing
[✓] Ticket reopening
[✓] Ticket archiving concept
[✓] HTML transcript generation
[✓] Transcript upload
[✓] Attachments in transcripts
[✓] Reply references in transcripts
[✓] Ticket creation cooldown
[✓] Add/remove users
[✓] SupportForge setup
[✓] Category management
[✓] Priority levels
[✓] Ticket tags
[✓] Internal staff notes
[✓] Audit logging
```

This checklist should be re-verified against code whenever the repository changes significantly.

---

# 46. KNOWN PLANNED GAPS FROM THE ORIGINAL VISION

The major gaps between the current Discord foundation and the complete product vision are:

```text
[ ] Full custom panel builder
[ ] Advanced configurable ticket forms
[ ] Conditional form fields
[ ] Closing-reason modal/system
[ ] Full ticket event timeline command/UI
[ ] Canned/saved staff responses
[ ] Automatic inactivity close
[ ] Ticket merge
[ ] Advanced assignment engine
[ ] Workload-based routing
[ ] Skill-based routing
[ ] SLA timers
[ ] SLA warnings and escalation
[ ] Business-hours-aware SLA
[ ] Queue management
[ ] Customer satisfaction ratings
[ ] Staff performance analytics
[ ] Department analytics
[ ] Voice-channel escalation
[ ] Knowledge base
[ ] Semantic knowledge search
[ ] AI summaries
[ ] AI suggested replies
[ ] AI classification
[ ] AI routing
[ ] AI translation
[ ] RAG
[ ] Custom SupportForge 8B model integration
[ ] Production external database
[ ] Database migrations
[ ] Real multi-tenant backend
[ ] Web dashboard
[ ] Web authentication
[ ] Advanced web RBAC
[ ] Real subscriptions
[ ] Real billing
[ ] Public API
[ ] Webhooks
[ ] Third-party integrations
[ ] White-labeling
[ ] Customer portal
[ ] Structured observability
[ ] Error tracking
[ ] Background workers
[ ] Job queue
[ ] Automated regression tests
[ ] Disaster recovery procedures
```

---

# 47. DO NOT REIMPLEMENT WORKING FEATURES JUST TO CHANGE THEIR LOCATION

Before a major refactor:

1. Identify the existing behavior.
2. Write tests for that behavior where practical.
3. Refactor behind stable interfaces.
4. Run the build.
5. Run tests.
6. Verify the Discord workflow.
7. Only then remove the old implementation.

Do not rewrite the transcript service, ticket state model, or permission logic merely because a new feature looks more exciting.

---

# 48. FEATURE IMPLEMENTATION STANDARD

Every future feature should have a mini-spec containing:

```text
Feature Name
Status
Priority
Purpose
User Story
User Roles
Inputs
Outputs
Data Required
Permissions
State Changes
Side Effects
Failure Cases
Dependencies
Configuration
Audit Requirements
Tests
Acceptance Criteria
```

This should be completed before implementation for non-trivial features.

---

# 49. FEATURE IMPLEMENTATION CHECKLIST

Before coding:

```text
[ ] Define the problem
[ ] Define user-facing behavior
[ ] Define permissions
[ ] Define state transitions
[ ] Define data required
[ ] Define persistence requirements
[ ] Define failure behavior
[ ] Identify dependencies
[ ] Decide whether Discord-only is sufficient
[ ] Decide whether database support is required
```

During coding:

```text
[ ] Keep business logic out of interaction handlers where practical
[ ] Validate inputs
[ ] Validate authorization
[ ] Add structured errors
[ ] Add audit events where needed
[ ] Avoid secrets in code
[ ] Keep interfaces testable
```

After coding:

```text
[ ] TypeScript/build succeeds
[ ] Automated tests pass
[ ] Existing workflows still work
[ ] Permissions verified
[ ] Failure paths verified
[ ] Documentation updated
[ ] FEATURES.md status updated
```

---

# 50. DEFINITION OF DONE

A feature is **not** complete merely because:

- a function exists,
- a button exists,
- the command deploys,
- TypeScript compiles,
- or a demo path works once.

A feature is complete when, according to the level of the feature:

```text
[ ] User-facing behavior exists
[ ] Service/domain logic exists
[ ] Permissions are correct
[ ] State/data is persisted correctly
[ ] Error handling exists
[ ] Audit behavior is implemented where appropriate
[ ] Existing behavior remains intact
[ ] Tests exist where appropriate
[ ] Deployment requirements are understood
[ ] Documentation is updated
```

---

# 51. TEST SCENARIOS THAT SHOULD NEVER BREAK

These workflows are foundational and should always be included in regression testing.

## Scenario A — New Ticket

```text
User opens panel
→ chooses department
→ submits form
→ ticket channel created
→ permissions correct
→ state = OPEN
→ ticket controls shown
```

## Scenario B — Claim

```text
Staff claims ticket
→ assignee recorded
→ state = CLAIMED
→ audit event created
```

## Scenario C — Pending

```text
Staff marks ticket pending
→ state = PENDING
→ correct notification
→ SLA behavior follows policy
```

## Scenario D — Close

```text
Authorized staff clicks close
→ closing reason collected if enabled
→ transcript generated
→ transcript stored/uploaded
→ audit event created
→ state = CLOSED
→ channel locked/archived according to configuration
```

## Scenario E — Reopen

```text
Closed ticket reopened
→ state = REOPENED
→ appropriate access restored
→ audit event created
```

## Scenario F — Duplicate

```text
User already has active ticket
→ duplicate request rejected according to policy
→ existing ticket reference may be shown
```

## Scenario G — Unauthorized Action

```text
Unauthorized user attempts staff action
→ action rejected
→ no ticket state mutation
→ security-relevant event may be logged
```

---

# 52. PRODUCT RULES

## Rule 1

Do not treat UI existence as feature completion.

## Rule 2

Do not use Discord permissions as the only source of ticket state.

## Rule 3

Do not let AI bypass deterministic authorization.

## Rule 4

Do not let AI failure break ordinary ticket support.

## Rule 5

Do not put secrets into Git.

## Rule 6

Do not add production database complexity before the data model is understood.

## Rule 7

Do not add billing before entitlement boundaries are clearly defined.

## Rule 8

Do not add a public API before authentication, authorization, validation, and tenant isolation exist.

## Rule 9

Do not claim a feature is `BUILT` until it is actually implemented and tested.

## Rule 10

Do not rewrite working code unnecessarily while adding unrelated features.

---

# 53. LONG-TERM REFERENCE ARCHITECTURE

```text
                            SUPPORTFORGE
                                 │
           ┌─────────────────────┼─────────────────────┐
           │                     │                     │
        DISCORD                 WEB                   API
           │                     │                     │
           └─────────────────────┼─────────────────────┘
                                 │
                         APPLICATION CORE
                                 │
       ┌───────────────┬─────────┼──────────┬──────────────┐
       │               │         │          │              │
    Tickets           SLA     Analytics  Automation      RBAC
       │               │         │          │              │
       └───────────────┴─────────┼──────────┴──────────────┘
                                 │
                           DATA PLATFORM
                                 │
             ┌───────────────────┼───────────────────┐
             │                   │                   │
          Database           Object Storage      Search/Vector
             │                   │                   │
             └───────────────────┼───────────────────┘
                                 │
                             AI PLATFORM
                                 │
            ┌────────────────────┼────────────────────┐
            │                    │                    │
        Summaries            Routing              RAG/Search
            │                    │                    │
            └────────────────────┼────────────────────┘
                                 │
                     SupportForge Model Layer
                                 │
                         Custom 8B Model
```

---

# 54. LONG-TERM PRODUCT MODULE MAP

```text
SUPPORTFORGE
│
├── Ticketing
│   ├── Creation
│   ├── Forms
│   ├── States
│   ├── Assignment
│   ├── Priority
│   ├── Tags
│   ├── Merge
│   └── Archive
│
├── Staff Operations
│   ├── Claiming
│   ├── Workload
│   ├── Canned Responses
│   ├── Notes
│   ├── Queue
│   └── Analytics
│
├── Automation
│   ├── Rules
│   ├── Auto-close
│   ├── Routing
│   ├── Notifications
│   └── Escalation
│
├── SLA
│   ├── First Response
│   ├── Claim
│   ├── Resolution
│   ├── Business Hours
│   └── Breaches
│
├── Knowledge
│   ├── Articles
│   ├── Search
│   ├── Ingestion
│   ├── Embeddings
│   └── RAG
│
├── AI
│   ├── Summaries
│   ├── Suggested Replies
│   ├── Classification
│   ├── Routing
│   ├── Translation
│   └── Custom Model
│
├── Platform
│   ├── Database
│   ├── API
│   ├── Workers
│   ├── Storage
│   ├── Observability
│   └── Security
│
└── SaaS
    ├── Dashboard
    ├── Auth
    ├── Billing
    ├── Entitlements
    ├── Integrations
    └── White Label
```

---

# 55. COMMERCIAL PRODUCT END STATE

The final product should allow a business to:

```text
1. Add SupportForge to Discord
2. Connect the server to the dashboard
3. Configure departments
4. Design support panels
5. Build forms
6. Configure staff roles
7. Configure SLA
8. Configure automation
9. Configure knowledge base
10. Optionally enable AI
11. Monitor tickets
12. Monitor support performance
13. Manage subscriptions
14. Connect external tools
15. Export/retain support records
```

The Discord experience should remain excellent even after the web platform exists.

---

# 56. THE SINGLE MOST IMPORTANT ARCHITECTURAL MILESTONE

The most important transition is not adding another Discord button.

It is moving from:

```text
Discord Bot
    ↓
Mostly Discord-contained state/logic
```

toward:

```text
Discord Bot
    ↓
SupportForge Core
    ↓
Persistent Backend
```

Once that boundary is stable, the web dashboard, API, AI, billing, analytics, and integrations become much easier to add without turning the Discord bot into a giant monolith.

---

# 57. WHAT THE CUSTOM 8B MODEL SHOULD NOT DO

Even in the final AI platform, the custom model should not be the authoritative system for:

- permissions
- authentication
- billing
- subscription status
- tenant isolation
- ticket ID assignment
- legal/retention rules
- database schema
- irreversible destructive operations

The model may recommend or assist with these workflows, but deterministic systems remain authoritative.

---

# 58. WHAT THE BOT SHOULD REMAIN GOOD AT

Even after SupportForge becomes a SaaS platform, the Discord bot should continue to be excellent at:

- fast ticket creation
- responsive interactions
- channel management
- permissions
- customer/staff notifications
- ticket controls
- support panel interactions
- Discord-native staff workflows

The web dashboard should augment Discord, not make the bot feel like an abandoned compatibility layer.

---

# 59. FUTURE EXPANSION IDEAS

These ideas are intentionally lower priority and should not distract from the primary roadmap.

Potential future features:

- email-to-ticket
- ticket-to-email
- customer identity synchronization
- mobile companion app
- push notifications
- advanced incident management
- status page integration
- AI quality review
- support-agent coaching
- multilingual dashboards
- advanced workflow designer
- marketplace for integrations
- developer SDK
- tenant-level API keys
- custom automation scripts with sandboxing

These should remain `FUTURE` until the primary product is stable.

---

# 60. IMPLEMENTATION ORDER REFERENCE

When deciding what to build next, use this order unless there is a specific technical reason to deviate:

```text
1. Reliability / bugs in existing ticketing
2. Tests around current behavior
3. Configuration diagnostics
4. Custom panels
5. Advanced forms
6. Closing reasons
7. Ticket timeline
8. Canned responses
9. Auto-close
10. Ticket merge
11. Better RBAC
12. Assignment engine
13. SLA
14. Business hours
15. Analytics
16. Voice escalation
17. Database
18. Backend API
19. Workers / queue
20. Web dashboard
21. Knowledge base
22. AI gateway
23. RAG
24. Custom model
25. Billing
26. Integrations
27. White-label / enterprise
```

This order is not a law of physics. It is the safest general progression for the current architecture.

---

# 61. WHEN YOU FORGET WHAT TO BUILD NEXT

Use this section as the recovery point after a long break.

### If the Discord bot still feels basic:

Work through Phase 1.

### If the ticket engine is stable but support teams need operational control:

Work through Phase 2.

### If the project needs persistent multi-server data:

Start Phase 3.

### If the backend is stable and the product has useful support data:

Start Phase 4.

### If the product is stable enough for external customers:

Start Phase 5.

Never jump directly to Phase 5 because a shiny dashboard screenshot looked persuasive on the internet. Software architecture remains annoyingly immune to motivational posters.

---

# 62. CHANGE MANAGEMENT FOR THIS FILE

Whenever a feature changes status:

```text
PLANNED → PARTIAL
PARTIAL → BUILT
BUILT → PARTIAL
PLANNED → INFRASTRUCTURE REQUIRED
```

update this document in the same development cycle.

If the implementation contradicts this file, verify the real code and then update the documentation.

Do not maintain two competing realities indefinitely.

---

# 63. FINAL REFERENCE CHECKLIST

Before declaring SupportForge “complete”, verify the following layers separately.

## Layer 1 — Discord Core

```text
[ ] Ticket creation
[ ] Departments
[ ] Permissions
[ ] State management
[ ] Claiming
[ ] Assignment
[ ] Close/reopen
[ ] Archive
[ ] Transcripts
[ ] Audit
[ ] Forms
[ ] Panels
```

## Layer 2 — Support Operations

```text
[ ] SLA
[ ] Queue
[ ] Business hours
[ ] Auto-close
[ ] Canned responses
[ ] Merge
[ ] Ratings
[ ] Analytics
[ ] Escalation
```

## Layer 3 — Backend

```text
[ ] Database
[ ] Tenant isolation
[ ] API
[ ] Migrations
[ ] Workers
[ ] Storage
[ ] Monitoring
[ ] Recovery
```

## Layer 4 — AI

```text
[ ] AI gateway
[ ] Summaries
[ ] Suggestions
[ ] Classification
[ ] Routing
[ ] Translation
[ ] Knowledge base
[ ] RAG
[ ] Evaluation
[ ] Custom model
```

## Layer 5 — SaaS

```text
[ ] Dashboard
[ ] Authentication
[ ] Billing
[ ] Entitlements
[ ] Public API
[ ] Webhooks
[ ] Integrations
[ ] White label
[ ] Customer portal
```

---

# 64. FINAL PRODUCT STATEMENT

SupportForge is not intended to remain a bot whose main trick is creating private Discord channels.

The Discord ticket system is the foundation.

The intended final product is a complete support platform combining:

```text
Discord-native ticketing
+
Support workflow automation
+
SLA and operational management
+
Analytics
+
Knowledge management
+
AI assistance
+
Persistent multi-tenant backend
+
Web dashboard
+
API and integrations
+
Commercial SaaS infrastructure
```

The core philosophy should remain:

```text
Reliable core first.
Automation second.
AI third.
SaaS after the architecture is ready.
```

The system should grow deliberately, with working features preserved and documented rather than repeatedly replaced.

---

# 65. DOCUMENT MAINTENANCE FOOTER

**Last major specification update:** September 2026  
**Purpose:** Long-term SupportForge product memory  
**Authority:** Product roadmap and requirements reference  
**Implementation authority:** Actual tested code takes precedence over stale documentation  

When a feature is implemented, update its status here.

When a requirement changes, update the description here.

When a major architectural decision is made, record it in `ARCHITECTURE.md` as well.

