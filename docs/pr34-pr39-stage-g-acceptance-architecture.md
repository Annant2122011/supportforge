# PR #34 / #39 Integration and Stage G Acceptance Architecture

**Purpose:** produce a testable integration snapshot containing the latest `main` plus PR #34 and PR #39 without accidentally deploying unaccepted Stage G changes to production.

## Safety boundary

The repository's `.github/workflows/deploy-server.yml` has a `push` trigger on `main`. After its verification job, it runs `npm ci`, builds, tests, runs `npm run db:migrate` and `npm run db:verify`, then restarts the configured production system service over SSH. Therefore, merging the two unaccepted PRs directly into `main` is a production rollout, not merely an integration operation.

All unaccepted changes belong on `integration/stage-g-acceptance`. No production guild, production Neon database, deployment secret, server, or migration target is used by this branch workflow. The branch is for a controlled, non-production Discord bot and isolated Neon acceptance.

## Dependency graph

```text
main (current baseline)
  |
  v
integration/stage-g-acceptance
  |
  +-- PR #34, merged first
  |     Stage 3 foundation: recovery vault, guarded backup/restore,
  |     SLA/CSAT storage and clocks, operation locks, recovery replay ledger
  |
  +-- PR #39, retargeted and merged second
        Consolidated Stages A-K layered over #34:
        Stage G permissions/close/inactivity, H localization,
        I knowledge base, J productivity tools, K analytics,
        presentation and diagnostics work
  |
  v
non-production Discord and isolated Neon acceptance
  |
  v
separate reviewed PR from this integration branch to main
(after recorded acceptance and explicit release approval)
```

## Merge protocol

1. Create this branch from the exact, reviewed `main` SHA. Do not reset, force-push, squash-rewrite, or cherry-pick the stacked chain.
2. Retarget PR #34 to this branch. CI must test GitHub's synthetic PR merge ref, not just the head commit. Confirm that ref includes the latest `main` base and the PR #34 head.
3. Require the full `ResolvX CI` workflow: TypeScript build, automated tests, and `npm run db:verify` against disposable PostgreSQL. Review errors rather than treating expected negative-test database logs as failures.
4. Merge PR #34 using a merge commit with the expected head SHA. Preserve the feature head as an ancestor and confirm the integration-branch push CI also passes.
5. Retarget PR #39 to this same integration branch after #34 is merged. Its diff must represent only the consolidated A-K layer beyond the merged #34 foundation; do not merge #39 against the obsolete standalone #34 branch or merge it before #34.
6. Require the same exact-merge-ref CI for PR #39; verify the tests and database migration checks, then merge with an expected head SHA. Confirm the final branch commit runs all CI checks.
7. Keep the integration branch available for non-production acceptance. Do not create a main-targeting release PR until the acceptance matrix below is completed and independently recorded.

## Persistence and migration invariants

- Neon PostgreSQL remains the production source of truth; SQLite is not a production substitute.
- PostgreSQL migrations remain additive and ordered. Existing migration identifiers are not renumbered.
- The current chain retains migration 12 (SLA policy/CSAT), 13 (recovery replay segments), 14-19 (knowledge base and productivity schema), 20 (analytics indexes), and 21 (claim SLA target). Migration 21 is shared by PR #34 and the consolidated PR #39; the stacked chain must contain it once, with the same name and definition, not create a second migration ID.
- CI uses disposable PostgreSQL only. It does not verify a Neon backup artifact, Neon branching, networking, provider credentials, or restoration of a real backup.
- Backups and manifests are sensitive; do not add them to Git.

## Stage G acceptance matrix

Execute only in a disposable Discord test guild with a non-production bot token and a separately isolated non-production Neon target. Record the exact integration commit and evidence for every scenario.

### Permissions and authorization
- Owner, allowed staff role, unauthorized member, administrator and bot identities.
- Claim, priority change, close, reopen, pending, recovery and destructive controls.
- Role removed while an interaction is open; channel permissions changed between preview and confirmation.
- Denied actions leave ticket state, events and messages unchanged and are audited without exposing secrets.

### Close / transcript / reopen
- Close sequence is transcript generation and upload confirmation, channel permission lock, durable closed-state/event/outbox write, panel/settings refresh, then final rename.
- Inject transcript upload failure, Discord 429, missing channel/message, database interruption and restart between each step.
- A close action must not display success or remain indefinitely in a thinking/deferred state when a step fails; retry and reconciliation must converge without duplicate transcript/event/outbox entries.
- Reopen keeps existing transcript/history; it does not delete or overwrite the prior transcript. Repeated close/reopen operations must use the correct lifecycle cycle and resolution-clock semantics.

### Inactivity and concurrency
- Warning/grace timers, customer or staff activity reset, exempt tickets, pending/closed tickets, restart recovery and scheduler overlap.
- Two handlers race to close/reopen/update a ticket; stale buttons and double-clicks; duplicate task execution across bot processes.
- Durable PostgreSQL state and optimistic/advisory locking decide the outcome. Only the winning transition is applied and audited.

### Private threads, panels, forms and interactions included in the consolidated layer
- Real role membership and channel/thread overwrites; add/remove participant, archive/lock/unlock, bot restart and missing permissions.
- Panel publish/update/delete compensation and preservation of server-authored content.
- Real Discord modal/component constraints, form versions, attachments, stale interactions and ephemeral response acknowledgement.
- Test each supported locale in Settings, panel configuration and analytics; component IDs must remain stable across language changes.

### Stage 3 recovery, SLA/CSAT and database recovery
- Read-only recovery preview, explicit confirmation, deletion-intent distinction, replay markers, duplicate clicks, concurrent workers, partial segment replay and restart.
- Claim/first-response/resolution clocks, pending pause, reopen cycle, duplicate warning/breach suppression, policy change behavior and actual Discord alert delivery.
- Create a verified backup artifact, restore it only into a newly created empty isolated non-production Neon target, then check manifest/checksum, schema/migration level, expected row counts, orphan/integrity checks, ticket/event/outbox/recovery state, and a bot smoke test.
- Never run restore against the configured production database or use a production backup in a casual acceptance exercise.

## Acceptance and release criteria

Source/CI green means **mergeable into this acceptance branch**, not production-ready. Stage G is accepted only when the controlled Discord scenarios and isolated Neon restore are executed and their evidence is recorded. Then run final CI against the exact release candidate and submit a separately reviewed PR from this branch to `main`. That later merge will trigger the existing production deployment workflow and must be treated as an explicitly approved rollout.
