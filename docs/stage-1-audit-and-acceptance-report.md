# Stage 1 Source Audit and Acceptance Report

**Programme:** ResolveX four-stage product excellence  
**Stage 1 branch:** `feature/stage-1-localization-acceptance`  
**Pull request:** [#31, Stage 1 configuration integrity, localization and acceptance](https://github.com/Annant2122011/supportforge/pull/31)  
**Current status:** The updated source and command-limit regression test passed CI on the cleanup base: TypeScript build succeeded, 138/138 tests passed with zero skips, and disposable PostgreSQL verification succeeded. Live Discord acceptance and an isolated Neon restore drill remain blocked pending access to a non-production environment.

## Evidence summary

| Area | Result | Evidence / limit |
|---|---|---|
| TypeScript build | **PASS** | [ResolvX CI #2045](https://github.com/Annant2122011/supportforge/actions/runs/39972325121) passed the TypeScript build on the updated Stage 1 + H2 test head. |
| Automated tests | **PASS** | [ResolvX CI #2045](https://github.com/Annant2122011/supportforge/actions/runs/39972325121) passed the expanded suite: 138 passed, 0 failed, 0 skipped, including slash-command option-limit coverage. |
| PostgreSQL verification | **PASS** | [ResolvX CI #2045](https://github.com/Annant2122011/supportforge/actions/runs/39972325121) verified required tables, referential integrity and the active outbox lease state against disposable CI PostgreSQL. This is not a connection to production Neon. |
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
4. Added regression tests for managed-default migration, custom-text preservation, role restrictions embedded in published panel snapshots, and recursive slash-command option limits / sibling-name uniqueness.
5. Reconciled the inactivity auto-close registry entry with the existing role/department exemption controls while keeping live acceptance clearly incomplete.
6. Added the four-stage programme architecture, a detailed non-production acceptance checklist and this evidence report.
7. Integrated the non-rebranding Stage H2 locale picker, sibling report command group (to stay within Discord command limits), and selected localized ticket lifecycle/form messages. This stays on the supported `/supportforge` command root and does not import QueryFixr branding.

## Branch / PR reconciliation

- [PR #33](https://github.com/Annant2122011/supportforge/pull/33) is a CI-baseline cleanup for the dangling Stage 2 history test currently present on `main` without its service. [PR #31](https://github.com/Annant2122011/supportforge/pull/31) temporarily targets that cleanup branch so the Stage 1 merge-test tree does not re-import the orphaned test. After #33 is reviewed/merged, retarget #31 to `main` before merging Stage 1. No direct change to `main` was made.
- [PR #32 is the H2-aware Stage 2 review branch](https://github.com/Annant2122011/supportforge/pull/32), stacked on this Stage 1 branch. It combines localization with Setup Doctor, operational task telemetry and configuration rollback. It carries the full configuration-history service plus its test, so that suite returns with Stage 2 rather than remaining orphaned on the baseline.
- Older drafts #24–#30 are superseded by the clean current PRs #31 and #32. Their histories remain intact; review the current PRs instead.
- [PR #23, Stage H Part 2 localization](https://github.com/Annant2122011/supportforge/pull/23) provided the H2 source increment ported into this branch. Its remaining Settings pages, panel previews, selected reports and live locale acceptance remain open in the translation checklist. [PR #22, the QueryFixr rebrand/localization branch](https://github.com/Annant2122011/supportforge/pull/22) remains separate because it changes visible branding and the root command name.
- No production deployment, live database change, direct `main` edit, force-push or history rewrite was performed. PR #33 isolates the baseline test cleanup as a reviewable dependency.

## Re-audit addendum — 2026-10-23

The current review chain is PR #33 → PR #31 → PR #32. PR #33, #31 and #32 remain open drafts; none is merged. Current recorded Stage 1 evidence is [ResolvX CI #2052](https://github.com/Annant2122011/supportforge/actions/runs/39972706424): build passed, 138/138 tests passed, zero skipped, and disposable PostgreSQL verification passed. This supersedes older CI runs for the same Stage 1 acceptance claim.

Remaining limits are unchanged: Stage H2 coverage still omits some Settings pages, panel previews and selected reports; actual test-guild interaction/permission and command-registration acceptance remains blocked; successful restore into an isolated non-production Neon target remains unverified. Automated checks passed, but Stage 1 remains **not production-accepted**. Review #33 first, then retarget #31 to `main`, then review #32 against integrated Stage 1.

## Release gate

Stage 1 is **not production-accepted** until the checklist in [stage-1-acceptance-checklist.md](stage-1-acceptance-checklist.md) is executed in an authorized non-production Discord guild, its results are recorded, and a backup is restored into a separate non-production Neon target.

Record every scenario as `PASS`, `FAIL`, `BLOCKED` or `NOT RUN` with an actual run/incident reference. Do not mark environment-dependent checks passed based only on unit tests.
