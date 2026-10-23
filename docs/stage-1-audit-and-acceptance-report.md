# Stage 1 Source Audit and Acceptance Report

**Scope:** Stage 1 of the four-stage ResolveX programme, with the existing Stage A–H code treated as the audited baseline.  
**Current branch head:** `671e69da454e8d383d1dbcf0103ae790000ab982`  
**Status:** Source/CI gates passed; live-guild and isolated Neon recovery acceptance are blocked pending an authorized test environment.

## Evidence summary

| Area | Result | Evidence / limits |
|---|---|---|
| TypeScript build | **PASS** | [Build run #1184](https://github.com/Annant2122011/supportforge/actions/runs/39951597149) succeeded on the current Stage 1 head. |
| Automated test suite | **PASS** | [ResolvX CI run #1865](https://github.com/Annant2122011/supportforge/actions/runs/39951597012): 140 passed, 0 failed, 0 skipped. |
| PostgreSQL verification | **PASS** | Same ResolvX CI run verified required tables, referential integrity and active outbox lease state against disposable CI PostgreSQL. |
| Custom branding/config preservation | **PASS in unit tests** | Exact built-in defaults are migrated; administrator-authored labels, descriptions, tags, buttons, confirmation text and custom footers are preserved. See `tests/managedBrandDefaults.test.ts`. |
| Persisted panel role restrictions | **PASS in unit tests** | Shared string-only Snowflake validation is exercised through the same sanitizer used by the config loader for draft panel/button restrictions and immutable published-panel snapshots. |
| Neon remains production provider | **PASS in source/CI review** | No provider change or live database migration was introduced. CI uses disposable PostgreSQL; it does not authenticate to or change production Neon. |
| Non-production Discord acceptance | **BLOCKED** | No test guild session/credentials were available for live permissions, interactions, role overwrites, rate limits, or command deployment validation. |
| Isolated Neon backup/restore drill | **BLOCKED** | No authorized disposable Neon target or backup artifact was available. CI database verification is not a production recovery drill. |

## Findings fixed in this pass

1. Replaced recursive branding replacement with exact-match migrations of application-owned defaults. The migration avoids rewriting custom server-created labels and copy.
2. Fixed persisted Discord role-ID validation. A malformed escaped digit pattern could fail to recognize valid Snowflake IDs. The shared validator treats IDs as strings, rejects malformed values, removes duplicates, and now sanitizes both draft and published role restrictions, including the published button list.
3. Corrected the retention summary so disabled retention is described as no timer with the configured maximum, not as unlimited retention.
4. Added regression coverage for custom text preservation, role restrictions and published snapshot data.
5. Preserved the live Neon/PostgreSQL architecture, existing JSON configuration/migration data and Stage A–H roadmap boundary.

## Repository / pull-request audit

- [PR #24, Stage 1](https://github.com/Annant2122011/supportforge/pull/24) contains the source-audit fixes and remains a draft pending live acceptance.
- [PR #25, Stage 2](https://github.com/Annant2122011/supportforge/pull/25) is stacked on this Stage 1 branch. It must be reviewed and merged after its own final CI and acceptance gates, not directly into `main` independently.
- [PR #23, Stage H Part 2 localization](https://github.com/Annant2122011/supportforge/pull/23) and [PR #22, QueryFixr rebrand/localization](https://github.com/Annant2122011/supportforge/pull/22) are separate drafts. They remain out of this branch: the QueryFixr PR changes visible branding and the root command name, so it is not safe to combine casually with ResolveX.
- No feature from either conflicting branch was silently copied into Stage 1. No force-push, history rewrite, production migration or deployment was performed.

## Remaining release gate

The code/CI portion of Stage 1 is green. Stage 1 is **not production-accepted** until a person with the test environment runs the live scenarios in [the acceptance checklist](stage-1-acceptance-checklist.md), saves the actual results, and completes a restore from a backup into a separate non-production Neon target.

Do not mark blocked checks as passed merely because unit tests passed. Test data should stay isolated from production tickets, channels and Neon records.
