# Stage 1 — Stabilization and Acceptance Checklist

This checklist is for a non-production bot and test guild. Do not use production ticket channels or run destructive integration tests against the production Neon project.

## Current evidence snapshot (2026-10-23)

- **Source/CI baseline:** PASS for the clean Stage 1 + Stage H2 branch at [PR #31](https://github.com/Annant2122011/supportforge/pull/31). [Build #1194](https://github.com/Annant2122011/supportforge/actions/runs/39959732876) passed; [ResolvX CI #1970](https://github.com/Annant2122011/supportforge/actions/runs/39959732860) passed with 137 tests, zero failures/skips, and disposable PostgreSQL verification.
- **Production store:** source checks preserve Neon/PostgreSQL; the CI database is disposable and does not establish production Neon connectivity or backup recoverability.
- **Discord acceptance:** BLOCKED / NOT RUN. No authorized non-production guild session was available for interaction, permission, published command, rate-limit and restart tests.
- **Neon restore drill:** BLOCKED / NOT RUN. No authorized isolated non-production Neon target or backup artifact was available.
- **Translation scope:** Stage H2's locale picker and selected ticket/form lifecycle messages are in this branch. The translation architecture still tracks the remaining Settings pages, panel previews and selected report surfaces as unfinished.

The checkboxes below separate source/CI evidence from live-environment acceptance. Do not mark blocked items as pass.

## 1. Source and dependency baseline

- [x] Inspect open pull requests and branches; document dependencies and identify conflicting branding branches. (See the Stage 1 audit report and PRs #31/#32; QueryFixr is kept separate.)
- [x] Confirm which Stage A–H code is actually merged into `main`. (The H2 increment is in PR #31 for review; it is not described as merged.)
- [x] Verify `main` keeps Neon/PostgreSQL as the live provider and does not silently fall back to SQLite.
- [x] Preserve existing JSON configuration documents, migration files, message archives, ticket metadata and recovery records. (Source changes are non-destructive; actual restore remains a separate gate.)
- [x] Verify that branding/content normalization changes only exact application-owned defaults and preserves all custom server text. (Regression tests cover custom labels/copy and published-panel role restrictions.)

## 2. Automated checks

- [x] TypeScript build passes on PR #31 head. [Build #1194](https://github.com/Annant2122011/supportforge/actions/runs/39959732876).
- [x] Full node:test suite passes on PR #31 head: 137 passed, 0 failed, 0 skipped. [CI #1970](https://github.com/Annant2122011/supportforge/actions/runs/39959732860).
- [x] PostgreSQL verification passes against disposable CI/test data. [CI #1970](https://github.com/Annant2122011/supportforge/actions/runs/39959732860).
- [x] Provider tests reject SQLite as the live production provider.
- [x] State-machine, metadata-only activity updates, transaction/outbox, retry and reconciliation regressions pass.
- [x] Forms: validation, conditional fields, stale sessions, version changes and attachment metadata tests pass.
- [x] Panels: published snapshots, stable button identities, role checks, confirmation binding and failed-publish compensation tests pass.
- [x] Support hours: scope inheritance, overnight intervals, invalid/overlapping intervals and DST-boundary tests pass.
- [x] Inactivity: activity reset, exemptions, stale anchors, policy changes, transcript failure and compare-and-close regressions pass.
- [x] Translation: supported locales, per-key English fallback, safe interpolation, formatting and preserved custom content tests pass. H2 page/command live acceptance remains open.
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
- [x] Record CI run links, fixes and untested limitations in the audit report. Live test-guild scenarios remain NOT RUN.
- [ ] Do not promote if critical permission/recovery tests fail or data preservation is uncertain.

## Reporting format

For every checklist item, record one of: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`. Include the run or incident reference and a concise note. Source inspection, automated CI, test-guild acceptance and production database verification are separate evidence categories.
