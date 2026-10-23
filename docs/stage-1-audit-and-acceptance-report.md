# Stage 1 Source Audit and Acceptance Report

**Programme:** ResolveX four-stage product excellence  
**Stage 1 branch:** `feature/stage-1-localization-acceptance`  
**Pull request:** [#31, Stage 1 configuration integrity, localization and acceptance](https://github.com/Annant2122011/supportforge/pull/31)  
**Current status:** Source and automated checks pass. Live Discord acceptance and an isolated Neon restore drill remain blocked pending access to a non-production environment.

## Evidence summary

| Area | Result | Evidence / limit |
|---|---|---|
| TypeScript build | **PASS** | [Build run #1192](https://github.com/Annant2122011/supportforge/actions/runs/39957752517) succeeded on the clean Stage 1 branch. |
| Automated tests | **PASS** | [ResolvX CI run #1951](https://github.com/Annant2122011/supportforge/actions/runs/39957752790): 135 passed, 0 failed, 0 skipped. |
| PostgreSQL verification | **PASS** | Same CI run verified required tables, referential integrity and the active outbox lease state against disposable CI PostgreSQL. This is not a connection to production Neon. |
| Managed branding migration | **PASS in unit tests** | Exact application-owned defaults are migrated; custom department names, tags, descriptions, panel text, button labels, confirmation copy and custom footers are preserved. |
| Panel role restrictions | **PASS in unit tests** | Role restrictions are normalized at the editable draft, button, published configuration and published-button layers. Valid Snowflake IDs remain strings, malformed IDs are rejected and duplicates are removed. |
| Localization controls/lifecycle copy | **PASS in CI; partial acceptance** | Stage H2 locale selection and focused Hindi/Bengali/English lifecycle/form copy are included on this branch. Remaining Settings pages, panel previews and selected report surfaces are still open in the translation architecture checklist.
| Production provider policy | **PASS in source/CI review** | Neon/PostgreSQL remains authoritative; no live provider switch or SQL migration was introduced in Stage 1. |
| Live test-guild acceptance | **BLOCKED** | No authorized test-guild bot/session was available to verify actual Discord REST permissions, published interactions, role overwrites, command registration, rate limits and restart behavior. |
| Non-production Neon backup/restore | **BLOCKED** | No authorized isolated Neon target/backup artifact was available. CI PostgreSQL verification is not a restore drill. |

## Confirmed findings and fixes

1. Removed recursive branding substitutions from the two configuration normalizers. Only exact known managed defaults are migrated; user/server-authored content is left intact.
2. Corrected persisted Discord role-ID normalization so draft and immutable published-panel access restrictions are treated consistently.
3. Corrected the Settings retention summary: a disabled timer is shown as no timer within the configured maximum, not “unlimited.”
4. Added regression tests for managed-default migration, custom-text preservation and the role restrictions embedded in published panel snapshots.
5. Reconciled the inactivity auto-close registry entry with the existing role/department exemption controls while keeping live acceptance clearly incomplete.
6. Added the four-stage programme architecture, a detailed non-production acceptance checklist and this evidence report.
7. Integrated the non-rebranding Stage H2 locale picker, sibling report command group (to stay within Discord command limits), and selected localized ticket lifecycle/form messages. This stays on the supported `/supportforge` command root and does not import QueryFixr branding.

## Branch / PR reconciliation

- [PR #31 is the clean Stage 1 + Stage H2 review branch](https://github.com/Annant2122011/supportforge/pull/31), based on the current `main` baseline. It replaces the older diverged Stage 1 draft for review.
- [PR #32 is the H2-aware Stage 2 review branch](https://github.com/Annant2122011/supportforge/pull/32), stacked on this Stage 1 branch. It combines localization with Setup Doctor and configuration rollback.
- Older drafts #24–#30 are superseded by the clean current PRs #31 and #32. Their histories remain intact; review the current PRs instead.
- [PR #23, Stage H Part 2 localization](https://github.com/Annant2122011/supportforge/pull/23) provided the H2 source increment ported into this branch. Its remaining Settings pages, panel previews, selected reports and live locale acceptance remain open in the translation checklist. [PR #22, the QueryFixr rebrand/localization branch](https://github.com/Annant2122011/supportforge/pull/22) remains separate because it changes visible branding and the root command name.
- No production deployment or database change was performed. The accidental Stage 2 file on `main` was removed with a normal corrective commit; comparing the resulting `main` tree against its prior baseline shows no net source/document changes from this programme on `main`.

## Release gate

Stage 1 is **not production-accepted** until the checklist in [stage-1-acceptance-checklist.md](stage-1-acceptance-checklist.md) is executed in an authorized non-production Discord guild, its results are recorded, and a backup is restored into a separate non-production Neon target.

Record every scenario as `PASS`, `FAIL`, `BLOCKED` or `NOT RUN` with an actual run/incident reference. Do not mark environment-dependent checks passed based only on unit tests.
