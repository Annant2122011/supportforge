# Stage 1 — Stabilization and Acceptance Checklist

This checklist is for a non-production bot and test guild. Do not use production ticket channels or run destructive integration tests against the production Neon project.

## 1. Source and dependency baseline

- [ ] Inspect open pull requests and branches; document dependencies and identify conflicting branding branches.
- [ ] Confirm which Stage A–H code is actually merged into `main`.
- [ ] Verify `main` keeps Neon/PostgreSQL as the live provider and does not silently fall back to SQLite.
- [ ] Preserve existing JSON configuration documents, migration files, message archives, ticket metadata and recovery records.
- [ ] Verify that branding/content normalization changes only exact application-owned defaults and preserves all custom server text.

## 2. Automated checks

- [ ] TypeScript build passes.
- [ ] Full node:test suite passes.
- [ ] PostgreSQL verification passes against disposable CI/test data.
- [ ] Provider tests reject SQLite as the live production provider.
- [ ] State-machine, metadata-only activity updates, transaction/outbox, retry and reconciliation regressions pass.
- [ ] Forms: validation, conditional fields, stale sessions, version changes and attachment metadata tests pass.
- [ ] Panels: published snapshots, stable button identities, role checks, confirmation binding and failed-publish compensation tests pass.
- [ ] Support hours: scope inheritance, overnight intervals, invalid/overlapping intervals and DST-boundary tests pass.
- [ ] Inactivity: activity reset, exemptions, stale anchors, policy changes, transcript failure and compare-and-close regressions pass.
- [ ] Translation: supported locales, per-key English fallback, safe interpolation, formatting and preserved custom content tests pass.
- [ ] Command registration stays within Discord's application command/component limits.

## 3. Test-guild acceptance

- [ ] Verify ticket creation and lifecycle through slash commands and buttons independently.
- [ ] Test missing permissions, stale/copied buttons, invalid role/channel IDs, unauthorized actions and private-thread access.
- [ ] Exercise each supported form field type, conditional multi-step flow, expired modal, form-version change and supported attachment path.
- [ ] Publish, edit, retarget, cancel and re-publish multiple panels; simulate a persistence and old-message cleanup failure.
- [ ] Test support-hours opening/closing boundaries, overnight schedules and one DST transition in a timezone that observes DST.
- [ ] Test private-thread create/owner/staff access, claim, pending, resume, close, reopen, archive, delete review and recovery.
- [ ] Test inactivity warning cancellation after new activity, a restart between warning and closure, disabled policies, exemption changes, inaccessible transcript destination and a ticket whose history exceeds the configured safety cap.
- [ ] Simulate Discord 429/rate-limit retries, missing channels, permission errors and database interruption in a controlled test environment.
- [ ] Test English, Hindi and Bengali locale selection, direct interactions, buttons, settings pages covered by H2, fallback and UI length boundaries.
- [ ] Confirm audits attribute important actions to the correct actor and never expose staff-only notes to ticket owners.

## 4. Data recovery and release gate

- [ ] Verify the intended Neon project and migration state using read-only checks first.
- [ ] Take a non-production backup and successfully restore it into an isolated test target.
- [ ] Confirm a restored ticket retains the original message attribution as metadata without pretending to restore original Discord author identities.
- [ ] Record CI run links, test-guild scenarios, failures, fixes and untested limitations.
- [ ] Do not promote if critical permission/recovery tests fail or data preservation is uncertain.

## Reporting format

For every checklist item, record one of: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`. Include the run or incident reference and a concise note. Source inspection, automated CI, test-guild acceptance and production database verification are separate evidence categories.
