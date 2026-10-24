# Stage 1 Source Audit and Acceptance Report

**Programme:** ResolveX four-stage product excellence  
**Stage 1 branch:** `feature/four-stage-excellence-stage-1-clean`  
**Pull request:** [#28, Stage 1 configuration integrity, source audit and acceptance](https://github.com/Annant2122011/supportforge/pull/28)  
**Current status:** Source and automated checks pass. Live Discord acceptance and an isolated Neon restore drill remain blocked pending access to a non-production environment.

## Evidence summary

| Area | Result | Evidence / limit |
|---|---|---|
| TypeScript build | **PASS** | [Build run #1192](https://github.com/Annant2122011/supportforge/actions/runs/39957752517) succeeded on the clean Stage 1 branch. |
| Automated tests | **PASS** | [ResolvX CI run #1951](https://github.com/Annant2122011/supportforge/actions/runs/39957752790): 135 passed, 0 failed, 0 skipped. |
| PostgreSQL verification | **PASS** | Same CI run verified required tables, referential integrity and the active outbox lease state against disposable CI PostgreSQL. This is not a connection to production Neon. |
| Managed branding migration | **PASS in unit tests** | Exact application-owned defaults are migrated; custom department names, tags, descriptions, panel text, button labels, confirmation copy and custom footers are preserved. |
| Panel role restrictions | **PASS in unit tests** | Role restrictions are normalized at the editable draft, button, published configuration and published-button layers. Valid Snowflake IDs remain strings, malformed IDs are rejected and duplicates are removed. |
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

## Branch / PR reconciliation

- [PR #28 is the clean Stage 1 review branch](https://github.com/Annant2122011/supportforge/pull/28), based on the current `main` commit. It replaces the older diverged Stage 1 draft for review.
- [PR #29 is the clean Stage 2 review branch](https://github.com/Annant2122011/supportforge/pull/29), stacked on Stage 1. It must not be merged before its Stage 1 parent.
- Older draft PRs #24 and #25 are superseded by #28 and #29. They remain separate, unmerged histories; review the clean PRs instead.
- [PR #23, Stage H Part 2 localization](https://github.com/Annant2122011/supportforge/pull/23) and [PR #22, the QueryFixr rebrand/localization branch](https://github.com/Annant2122011/supportforge/pull/22) remain separate review items. The QueryFixr branch changes visible branding and the root command name, so it was not copied into ResolveX.
- No production deployment or database change was performed. The accidental Stage 2 file on `main` was removed with a normal corrective commit; comparing the resulting `main` tree against its prior baseline shows no net source/document changes from this programme on `main`.

## Release gate

Stage 1 is **not production-accepted** until the checklist in [stage-1-acceptance-checklist.md](stage-1-acceptance-checklist.md) is executed in an authorized non-production Discord guild, its results are recorded, and a backup is restored into a separate non-production Neon target.

Record every scenario as `PASS`, `FAIL`, `BLOCKED` or `NOT RUN` with an actual run/incident reference. Do not mark environment-dependent checks passed based only on unit tests.
