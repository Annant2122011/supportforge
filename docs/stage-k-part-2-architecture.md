# Stage K Part 2 — Advanced operational analytics

**Implementation branch:** stage-k-part-1-analytics-foundation  
**Persistence:** Existing Neon/PostgreSQL source of truth  
**Surface:** Administrator-gated Discord slash command and Settings dashboard

## Included capabilities

Part 2 extends the Part 1 guild roll-up with filterable department, staff workload, tag and trend views, previous-period comparisons, and bounded CSV export. The new query and service code is separated from the Settings interaction handler.

### Filters and report windows

- Rolling UTC windows are 7, 30 or 90 days. Comparisons use the immediately preceding equal-duration window and display exact boundaries.
- Optional department ID, tag ID, priority and current ticket status filters are validated on the server before they become bound SQL parameters.
- Unsupported values, injection-style IDs and invalid periods are rejected; no user-provided value is interpolated into SQL.
- Filters are intended to scope ticket cohorts consistently across aggregate, breakdown, trend and coverage queries.

### Department breakdown

Each department row includes period ticket creation, current active backlog, open/reopened, claimed and pending counts, urgent/critical active tickets, first-resolved tickets, reopened tickets, first-response eligibility and sample coverage, average first response and first-resolution time, and oldest active ticket age.

Tickets with no department remain visible in an Unassigned row. Department labels come from the current configuration; missing historical mappings are displayed as an Unknown department entry rather than dropped.

### Staff workload

The staff view includes active workload, tickets claimed and closed during the period, attributable staff replies, first responses and average first-response time. Only high-confidence, explicitly attributed staff actions with valid Discord user IDs contribute to staff-specific activity metrics.

This is an operational workload report, not a leaderboard. A staff member's ticket count is not a measure of ticket difficulty, support quality or individual worth. Staff identifiers are shown rather than fetching historical display names from Discord.

### Tag distribution

The tag view reports tickets created, current active backlog, first resolutions and urgent/critical active tickets for each tag. Untagged tickets remain represented. Unknown tag mappings are displayed under a safe placeholder instead of being discarded.

### Trends and comparisons

The trends view displays daily UTC observations for 7-day reports and compact weekly UTC aggregates for 30/90-day reports. It covers tickets created and first resolved; these are descriptive observations, not predictions. The overview compares current and previous equal-length periods for created tickets, first resolutions, close actions, reopened tickets, average first response, average resolution and reopen rate.

A percentage change is shown as unavailable where a valid denominator does not exist. In particular, changes from a previous value of zero are not reported as an invented percentage.

### Data coverage

The report surfaces:
- ticket records in the selected cohort;
- tickets with a durable creation event;
- message-event count;
- messages with explicitly attributed author type and a valid source timestamp;
- unknown author type count;
- missing/invalid timestamp count;
- observed lifecycle event count;
- first-response sample coverage.

Coverage makes historical gaps visible. The reports do not manufacture missing events or assign unknown messages to customers or staff.

### CSV export

The export includes summary, department, staff, tag and daily-trend rows. It uses a fixed column order, proper CSV quoting and newline handling, and a hard cap of 2,000 rows and 1 MiB. User-controlled text that begins with spreadsheet formula characters (=, +, - or @, including after whitespace) is neutralized before the cell is quoted. Message content, transcript content, attachment URLs, secrets and private notes are not read for this export.

The slash command supports view and filter options. The Settings dashboard provides overview/comparison, department, staff, tag and trend tabs, paging controls, and CSV export for an unfiltered report.

## Metric interpretation contracts

- “Created” is based on non-deleted ticket records created inside the window.
- “First resolved” uses the earliest durable ticket.closed event per ticket, not every close action.
- “Close actions” can exceed unique first-resolved tickets because a reopened ticket can be closed again.
- “Average first response” uses the customer's first durably recorded message timestamp and the first later staff message timestamp. Only valid source timestamps and explicit author types qualify.
- “Current active workload” is a snapshot of current active ticket assignment metadata, not a historical daily workload curve.
- Staff-specific counts require durable high-confidence actor attribution.
- Current department/tag mappings are used for breakdown labels. A current mapping may not be identical to the mapping when a historical ticket was created; Part 2 does not pretend otherwise.

## Security and operational safeguards

- All data queries bind guild ID and reporting boundaries as SQL parameters.
- Optional filters are whitelisted and bound parameters.
- Deleted tickets are excluded from the filtered ticket cohort; event joins are restricted to those ticket IDs and the requested guild.
- No raw message bodies or transcripts are selected by analytics queries.
- Administrative access is checked in the slash-command path and in Settings component handlers.
- Export is bounded before the file is returned; formula-leading strings are escaped to reduce spreadsheet formula injection risk.
- SQL resides in dedicated repositories, business rules reside in the analytics service, and Discord formatting resides in presentation modules.
- The report uses the existing durable PostgreSQL event ledger and never depends on process-local analytics caches.

## Deliberate exclusions

SLA compliance is not fabricated: the current repository does not expose a complete authoritative SLA policy/event history with durable breach timestamps for all tickets. CSAT is also excluded because an authoritative, durable rating source is not available. Both require their own source-of-truth data model and acceptance criteria before a percentage or score can be trusted.

## Acceptance checklist

- [ ] TypeScript build passes.
- [ ] All automated tests pass, including configuration-history restore guards, multilingual knowledge normalization, analytics filter validation and CSV safety.
- [ ] PostgreSQL migration and integration verification pass in CI.
- [ ] Department and tag reports retain unassigned/untagged rows.
- [ ] A second guild's records do not affect the report.
- [ ] Staff metrics exclude inferred or unknown actor attribution.
- [ ] Invalid filter values fail closed.
- [ ] CSV row/size caps and formula neutralization are covered by tests.
- [ ] A non-production Discord guild accepts slash-command reports, Settings tabs, pagination and CSV download before production rollout.
