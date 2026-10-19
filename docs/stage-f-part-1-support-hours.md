# Stage F Part 1: Support Hours and Time-Zone Service

## Scope split

- **Part 1 (this increment):** shared support-hours policies, timezone-aware schedule evaluation, Settings-channel editor, slash-command configuration, final ticket-intake enforcement, audit events and unit tests.
- **Part 2 (deferred):** private-thread ticket workspaces and their Discord resource adapter. No private-thread ticket creation or lifecycle code is included in Part 1.

## Architecture

The schedule and policy logic lives in src/services/supportHoursService.ts; interaction handlers do not implement date arithmetic themselves. Policies persist in the generic Neon-backed JSON-document store under the separate support-hours document. The service validates policy writes, versions every saved policy, and preloads the document before the bot logs in so ticket buttons do not initiate a cold database read before their Discord acknowledgement.

Resolution precedence is:

1. Panel-specific policy.
2. Department-specific policy.
3. Guild default policy.
4. No configured policy means unrestricted ticket creation.

A policy at a more-specific scope is an override, including an explicitly disabled policy. Deleting an override restores inheritance.

## Policy behavior

A policy contains an enabled flag, an IANA time-zone ID, weekly day intervals, an outside-hours behavior (allow or restrict), a monotonically incremented version, and update actor/time metadata.

- **restrict:** block new ticket intake outside configured intervals, return a private explanation and calculated next opening when available, and write a SUPPORT_HOURS_BLOCKED audit event.
- **allow:** permit new ticket creation outside hours; report the closed status and next opening in policy/status views.
- **enabled=false:** do not enforce the stored schedule.
- No policy: preserve legacy behavior and do not block intake.

Existing tickets and administrator operations are unaffected by the policy. Panels remain published at all times.

## Time-zone rules

The schedule stores local wall-clock intervals plus an IANA time-zone ID. Actual event timestamps continue to be represented as instants. The engine:
- supports multiple intervals per weekday and overnight intervals such as 22:00-02:00;
- rejects overlapping intervals, including overlaps across midnight;
- uses the same evaluator for open/closed status and next-opening calculations;
- resolves nonexistent local opening times during a spring-forward transition to the first valid later minute on that local date;
- uses the earlier instant for an ambiguous repeated local start time and the later instant for the corresponding end time in the autumn transition, preventing the interval from closing early;
- uses a shared, injectable reference instant for unit tests.

The current scope intentionally does not add a holiday calendar or ad hoc exception-date editor because these are not required by the master roadmap's Stage F definition.

## Entry-point enforcement

The shared support-hours admission check is called on ticket-entry paths where schedule context is available and again inside the final ticket-creation path. Published custom panel identity is carried through tag selection and multi-step form modal IDs so panel overrides remain enforceable when the final submission occurs.

This is intake enforcement, not an inactivity-closure engine or SLA implementation. Stages G and L will consume the time service later; Part 1 does not implement those later stages.

## Configuration

The Settings-channel Support Hours button edits the guild-default time zone and complete seven-day schedule, can enable/disable enforcement, and can switch outside-hours behavior. More-specific policies use /supportforge settings support-hours:

- show
- set-timezone
- set-day
- behavior
- enable
- disable
- clear-scope

A department or panel scope requires its existing ID. The server-default scope does not take an ID. The schedule editor requires all seven day lines and uses day=intervals, with closed for a closed day.

## Verification

Automated tests cover:
- interval parsing, validation and cross-midnight overlap;
- panel > department > guild policy precedence;
- open/closed boundaries and next-opening calculations;
- intervals that cross midnight;
- IANA time-zone validation;
- spring-forward nonexistent times and autumn repeated times;
- the seven-day editor input format.

Before production use, manually verify the schedule UI and ticket-opening flows in a real Discord test server. CI passing is necessary but does not replace Discord API permission/interaction acceptance.
