# Finance product implementation plan for Luna High

Prepared 2026-10-28. Input: [product review](PRODUCT_REVIEW_2026-10-28.md). Intended executor: Luna with high reasoning, selected by the user in the execution session. This document does not launch an agent or change the model.

## Objective and scope

Make Ledger dependable for a complete personal budgeting workflow: start with an empty account, plan the intended month, recover uncertain saves, explain historical totals, reconcile records, and recover or export the data.

This is the active plan for the new product review. The earlier [stability plan](STABILITY_IMPLEMENTATION_PLAN.md) and [execution record](STABILITY_EXECUTION_2026-10-28.md) remain historical contracts and regression evidence. Do not restart their completed work. All tasks below begin **NOT_STARTED**; prior broad test passes do not satisfy the new cases.

Deliver three independently reviewable increments:

| Increment | Tasks | Exit condition |
| --- | --- | --- |
| A: usable and consistent budgeting | P00–P04 | Empty-account planning works, saves target the selected month, category limits survive reload, and historical totals agree across screens. |
| B: trustworthy storage and recovery | P05–P09 | Browser reload recovery works, replay records are indexed and minimized, complete budget records persist together, edits have history, and forecasts explain their limitations. |
| C: dependable owner workflow | P10–P15 | Statement reconciliation, understandable editing, honest recovery status, encrypted backup export, portable financial export, and candidate acceptance pass. |

Transaction splitting and recurring-bill automation are specified as a separate follow-on increment, P16–P17. They are not prerequisites for repairing the confirmed defects. Do not describe those features as implemented when handing off A–C.

## Non-negotiable boundaries

- Preserve the dirty working tree. The reviewed base was `6d5fc0cfadf6e82c0bc65ef78329e8c9a51f0834`; recheck it before work. Never reset, clean, stage, or commit unrelated work. Original-checkout commits, deployment, service changes, and bank access require a separate user instruction.
- Do not read or modify `docs/IMPLEMENTATION_PROGRESS.md`. Do not include it or `docs/STABILITY_REVIEW_2026-10-27.md` in copies or scans. Write code-only results to a new `docs/PRODUCT_IMPLEMENTATION_EXECUTION.md`.
- Use Node 24.22.1 and locked dependencies. Keep SQLite, the existing JavaScript architecture, and current security controls. Do not upgrade dependencies or introduce a framework to make a check pass.
- Use disposable synthetic data and explicit test configuration. Never load the owner's configuration, database, tokens, balances, exports, or recovery files. Build and test in a disposable copy of reviewed source, including new files and excluding private/generated artifacts. A disposable Git repository is allowed for synthetic release rehearsal; the original checkout remains unstaged.
- Preserve integer cents; null means unknown and zero means known zero. Preserve weekly × 4, annual ÷ 12, and semiannual ÷ 6 with existing cent rounding. Explain weekly × 4 rather than changing it to an annual average.
- Preserve record IDs, provider facts, overrides, old budget periods, account observations, and audit history. Pending and non-USD records remain excluded from USD spending totals. Transfers count in account reconciliation even though they do not count as spending.
- Sample mode remains isolated and makes no persistent writes. No financial form contents or bank data may be cached in browser storage as part of save recovery.
- Work sequentially. Complete one named subtask and record its evidence before starting another. Continue authorized work without asking for routine design approval. Do not spawn agents unless the user explicitly requests delegation.

## Execution method

For each task: read only its implementation surfaces and relevant shared contracts; establish the failing case; implement the smallest coherent change; run the focused regression; record the result. If the source has advanced, verify the finding before changing code. Do not weaken assertions to accommodate a defect.

Use source symbols below rather than relying on line numbers, which will drift. New modules and browser-case names in this plan are proposals until added and wired into the build/harness. Preserve all existing cases.

Record:

```text
Task/subtask and status: NOT_STARTED | IN_PROGRESS | PASS | FAIL | BLOCKED
Source base + relevant changed files:
Failing reproduction and independently expected result:
Changes and resulting contract:
Commands, exit status, runtime/backend/fixtures:
Remaining limitations and exact next subtask:
```

A task is PASS only when its acceptance cases pass. Manual and external checks are NOT_RUN when unavailable. Do not rerun every suite after a documentation change; run focused tests per task and integrated checks at increment boundaries.

## Increment A

### P00 — Capture the candidate and add independent product regressions

**Read:** `scripts/browser-cases.mjs`, `scripts/check-browser.mjs`, `scripts/check-budget.mjs`, `scripts/check-sqlite.mjs`, review report, package scripts.

1. Record HEAD, safe changed/untracked paths, runtime, and source identity without reading protected files. Create the new execution log.
2. Add selectable browser cases `budget-empty-onboarding`, `budget-create-month`, and `budget-archive-history`. Cases must use fresh synthetic SQLite and fail for the product issue, with existing bounded cleanup and failure artifacts.
3. Add focused SQLite/JSON parity cases for category creation/limits. Preserve a deterministic API-client reproduction of uncertain account creation after client replacement; P06 will add real page reload coverage.

**Expected initial failures:** zero editors on an empty budget page; optional-amount bucket cannot receive its first plan; September creation produces an October template; 51 SQLite category creates succeed despite the cap. Reproduce archive behavior independently before classifying that case as confirmed.

**Done:** named cases execute separately and report product failures accurately. A red regression is expected until its repair; harness failures are not acceptable substitutes.

### P01 — Allow planning before transactions exist

**Read/change:** `ui/browser.js` (`budgetPage`, `categoryManager`, `openCategoryDialog`, budget form binding), `ui/dialogs.mjs`, browser case.

**Contract:** add an accessible “Add category to plan” action listing existing eligible expense/allocation categories, including categories with no activity and no plan. Selecting one opens an editor for that existing ID. Creating a new category remains a distinct action. Do not force duplicate category creation or fabricate zero-dollar plans merely to reveal an editor.

**Acceptance:**

- Empty database: choose Housing, save $1,000 recurring, reload, and see exactly 100,000 cents and the same system category ID.
- Create a custom bucket with blank amount, then give it a $75 plan without first importing a transaction.
- Blank and zero remain distinguishable; saving zero does not hide the category.
- Archived categories require restoration before a new assignment; existing historical plans remain readable.
- Keyboard open/save/cancel works at 1440 and 390 CSS px; cancellation performs no write. Sample mode performs no write.

**Done:** users can build a first budget entirely through the UI before any spending exists.

### P02 — Save new buckets into the intended month and scope

**Read/change:** `openCategoryDialog`, `handleBudgetMutationRoute` category creation, `shared/budget-frequency.mjs`, budget/browser checks.

**Contract:** show an effective month initialized from the selected budget month, plus “This month only” or “Recurring from this month.” Default to recurring to preserve the existing creation behavior, but make it explicit. Submit and validate `month` and `mode`. Existing older clients omitting both retain the documented current-month recurring default. Reject malformed supplied values.

Use one validated source amount for both storage and monthly derivation; do not allow `amount` and `schedule.sourceAmount` to encode conflicting amounts. Normalize legacy callers consistently or reject conflicts.

**Acceptance:** with a fixed reporting date in October, create a September $100 monthly-only bucket: September resolves 10,000 cents, October has no plan. Create a September recurring bucket: September and October resolve 10,000; August remains unknown. Verify annual/weekly source amounts and schedules after SQLite restart. Blank creates the category without fabricating a plan. Success text names the effective month and scope.

**Done:** both API and UI agree on selected month, scope, original period amount, and derived monthly cents.

### P03 — Repair category authority and persistence

**Read/change:** `categoryCatalog`, category-create/update handlers, repository load/persist budget paths, JSON adapter, category checks.

**Contract:** use canonical category records for identity and the custom-category cap. Count all custom records, including archived ones, toward the existing 50-record creation cap. Preserve existing installations above that cap; block further creation without deleting their data. Legacy `customCategories` is a compatibility projection, not an independent authority.

**Subtasks:** P03a fix the cap and SQL compatibility projection without a broad schema refactor; P03b normalize legacy-only fixtures deterministically while retaining stable IDs and assignments. Do not merge ambiguous records solely because names are similar; reject/flag conflicting legacy identity mappings.

**Acceptance:** 50 creates succeed and the 51st returns a clear validation error in both adapters; results survive reopen. A fixture already containing 51 records remains readable/editable. Rename/archive/restore preserve IDs and category references. Creating a category does not rewrite transaction rows. Verify canonical/projection agreement after create, rename, and a full-state mutation.

### P04 — Give Overview and Budgets the same historical model

**Read/change:** `budgets`, `monthlyComparisonPanel`, `budgetPage`, `shared/budgets.mjs`, budget-summary response, archive handling.

**Contract:** derive equivalent totals from one pure month-specific model shared by both screens. Current archive status must not remove earlier plans or activity. Archiving hides a category from new transaction assignment; it does not silently terminate recurring funding. Explain this in the confirmation. P08 adds an explicit future-funding action.

**Acceptance:** September $100 plan and $20 spending: archive in October, then both September screens still show a $100 plan and $80 remainder. Verify October behavior agrees too, including carryover. Test expense/allocation separation, archived actual-only categories, refunds, group mappings, month overrides, and prior/current revisions. A known zero plan displays $0, not “No set limit.”

**Increment A gate:** focused cases plus integrated `npm run check`, full browser journey, and local HTTP checks from the synthetic source copy. Report unresolved P1s; do not hide them behind broad suite passes.

## Increment B

### P05 — Move replay records into bounded-work indexed storage

**Read/change:** `operationFingerprint`, `findOperationReplay`, `mutateWithReplay`, both repositories, SQLite migrations, migration table whitelist, build assets, release/recovery checks.

**Subtasks:** P05a define repository operation lookup/write contracts and digest semantics; P05b add migration and atomic SQLite persistence; P05c migrate legacy replay entries and verify parity/performance. Allocate the next unused schema version after inspecting the current tree.

**Contract:** operation identity is owner-scoped and unique; store scope, canonical SHA-256 payload digest, result needed for replay, revision, and timestamp in an indexed operations table. Include all semantically relevant request fields; document revision treatment and preserve existing conflict behavior. A committed domain mutation and its operation result must commit in the same transaction. Never implement them as separate commits.

Transform existing serialized fingerprints deterministically, preserving old IDs and replay responses. Remove legacy raw payload entries only after successful transactional migration. Keep the JSON adapter behavior equivalent. Include any new tables in backups, schema validation, asset packaging, and compatibility checks.

**Retention:** initially retain minimal records and results durably; remove raw request payloads and hot-path full-history scans. Do not add automatic record expiry in this increment. Any later result pruning must retain a permanent operation tombstone and return an explicit expired/unrecoverable status, never treat an old committed ID as a new request. Define this contract in documentation.

**Acceptance:** same ID/same request replays exactly; changed payload conflicts; stale-revision replay returns its committed result; crash/rollback cannot leave only the mutation or only its result. Legacy IDs replay after migration/reopen. SQL queries use the operation index. A saved CSV operation contains a digest, not raw CSV request text. Benchmark 10k and 100k operation records and repeated imports, verifying metadata size no longer grows with replay payload history. Report measurements without arbitrary speed claims.

### P06 — Recover uncertain saves across browser reloads

**Depends on:** P05.

**Read/change:** `ui/requests.mjs`, form submission bindings, API operation-status route, repository operation lookup, HTTP/browser checks.

**Subtasks:** P06a authenticated read-only status endpoint; P06b browser pending-operation metadata and recovery UI; P06c real reload/restart failure matrix.

**Contract:** before sending a replay-safe write, persist only `{operationId, scope, baseRevision, startedAt}` in same-tab session storage. No names, values, account IDs, CSV, credentials, or full request bodies. Explain this small storage exception in README; existing claims of no browser transaction cache remain true. Clear metadata only after confirming the outcome or explicit recovery resolution.

On reload, look up pending operations before allowing an uncertain create to be silently repeated. A committed result refreshes saved state and reports success. Unknown/not-found is **unconfirmed**, not proof of failure: the original request may still be in flight. Never create a fresh operation automatically because a lookup is absent or unavailable. Retrying re-entered values uses the same ID and original revision; changed payloads require explicit conflict handling. Provide a deliberate “new separate record” path after showing the recovery result. Name-based deduplication is forbidden.

The status endpoint must enforce the existing owner boundary, reveal no record to an unauthorized caller, and use no-store responses. If session storage is unavailable, report the reload-recovery limitation instead of falsely promising protection. No automatic replay of provider token exchange or unlink/delete-history.

**Acceptance:** commit manual-account create, drop both responses, reload the actual page, resolve operation, and show one account. Repeat with server restart, failed lookup, delayed original request, and expired-result tombstone. Exercise category/goal/property/mortgage/scenario creates, CSV imports, and budget updates using a shared recovery harness. Confirm original values/revisions are not silently replaced. Legitimate separate same-name records remain possible. Inspect browser storage to prove it contains no financial payloads. Test sample entry/exit and pending-operation cleanup.

### P07 — Store complete budget records together

**Depends on:** P02–P05.

**Read/change:** budget SQL tables/migrations, repository serializers, `shared/budgets.mjs`, `shared/budget-frequency.mjs`, budget routes and summary, migration/build/recovery checks.

**Contract:** template and override records own category ID, effective month, scope, monthly cents, source cents, frequency, and due month together. Category-level labels/grouping remain separate. Enforce valid dates/frequencies, null/zero meaning, unique keys, source/monthly consistency, and existing supported bounds in API and persistence layers. Retain compatibility response projections until UI consumers are migrated.

**Subtasks:** P07a shared validation/model; P07b transactional migration of amounts plus schedule metadata; P07c repository/API projection removal only after all consumers use the canonical model.

Legacy monthly amounts without schedule metadata become monthly records with the same cents. Never guess an annual/weekly original amount from a rounded monthly amount. Preserve missing-history boundaries. Ambiguous or inconsistent legacy schedules require a clear failure/report with a verified pre-migration backup, not silent correction.

**Acceptance:** weekly/annual/semiannual, rounding, zero, null, reset, same-month edits, future templates, grouped categories and historical rollovers remain identical before/after migration. Old-to-new upgrade is atomic and repeat-safe. Older incompatible application versions refuse the new schema. Failed migration leaves the original state usable. JSON and SQLite resolve equivalent fixtures identically.

### P08 — Add budget history and explicit future-funding controls

**Depends on:** P07 and replay handling.

**Subtasks:** P08a append-only budget change history; P08b read/compare/revert UI; P08c preview and apply “Stop future funding.”

**Contract:** record before/after values, category/month/scope, action, revision, operation ID, and timestamp atomically with each budget, income-plan, outlook, or reset edit. Replays must not add duplicate history. Revert creates a new revision and audit entry; it never deletes history or overwrites concurrent edits.

Stopping funding from a chosen month uses a known zero allocation, preserving accrued carryover; clearing a plan to unknown is a different action. Preview later recurring templates and month overrides that would otherwise resume funding. Apply only the explicitly confirmed scope, preserving earlier months and auditing every changed record. Archival remains separate.

**Acceptance:** three edits to the same month remain inspectable; reverting one does not alter another category; stale revert conflicts; zero/null/reset are distinguishable; stop funding handles later scheduled plans without surprising reactivation; cancellation changes nothing.

### P09 — Explain forecast confidence and budget balances

**Depends on:** P04, P08.

**Read/change:** `calculateBudgetPlan`, budget/Overview presenters, budget-summary detail support.

**Contract:** stop implying that the absence of unplanned transactions proves a complete plan. Show missing inputs, user-reviewed assumptions, excluded/stale data, and unplanned activity separately. An income-only plan must say expenses have not been established. User confirmation of commitments is an explicit dated acknowledgement, not a calculation of financial completeness.

Provide a breakdown of opening carryover + this month's allocation − posted spending = remaining allowance. Link spending to matching transactions and carryover to prior periods/history. Distinguish allowance, recorded cash, and expected month-end surplus. Preserve unknown values and label forecast defaults, including weekly × 4.

**Acceptance:** income-only setup, unknown income, zero income, unplanned net-zero activity, refunds, stale accounts, and missing history produce truthful labels. A $100 opening allowance + $200 allocation − $250 spending displays $50 with a traceable breakdown. No “safe to spend” claim is inferred from that $50.

**Increment B gate:** integrated checks, focused migrations/replay/browser reload cases, performance samples for operation history, and synthetic packaged-release upgrade/rollback compatibility rehearsal. No live activation.

## Increment C

### P10 — Add statement reconciliation without inventing missing history

**Depends on:** P05, P08. Add a separate statement-reconciliation module; existing provider-sync reconciliation is a different responsibility.

**Subtasks:** P10a pure signed-balance calculation; P10b persisted reconciliation observations/API; P10c account workflow and discrepancy drill-down; P10d review/close snapshots.

**Initial supported scope:** USD depository and credit accounts with an explicit opening statement balance/date and closing statement balance/date. Treat positive depository balances as assets and positive credit balances as debt. Use posted transactions after the opening date through the closing date, including transfers and refunds; pending rows are excluded. Explain the date convention and flag incomplete imported/provider history. Investments, unsupported currencies, and unavailable opening balances return unsupported/incomplete rather than a fabricated reconciliation.

**Expected arithmetic:** depository opening $1,000 + $500 income − $200 purchase − $100 transfer out = $1,200. Credit opening debt $300 + $50 purchase − $100 payment − $20 refund = $230. Each fixture must reconcile to zero discrepancy only when closing observations match.

Store immutable reviewed observations, transaction revision/coverage, calculation version, and result. Never change account balances or transactions to force a match. Later imports/edits affecting the period mark the result as needing review; unrelated edits outside the period need not invalidate it. Month close is initially an immutable review snapshot, not a global write lock. Reopen/correct creates a new review record.

**Acceptance:** missing/duplicate transactions, transfers, pending-to-posted changes, late refunds, changed history, and inconsistent dates yield visible discrepancies or review status. A sync timestamp alone never makes an account reconciled.

### P11 — Simplify budget editing and make ordering predictable

**Depends on:** P01, P04, P08–P09.

**Contract:** use a concise read view with a named Edit action; reveal period amount/frequency/due month/scope inside an accessible editor. Keep source amount and monthly equivalent visible together. Preserve entered values on failures and conflicts. Use stored category ordering within groups so move actions affect the displayed budget; clearly define the order that each control changes.

**Acceptance:** keyboard open/cancel/save/focus restoration; long labels; archived history; visible pending/error states; 1440/390/320 CSS px; accessible table/dialog names and roles. Do not call a 720px viewport a physical 200% browser zoom test. Record actual screen-reader and physical zoom checks separately when available.

### P12 — Make security and recovery status truthful and actionable

**Read/change:** runtime status, `recovery-bundle.mjs`, backup runner, Settings and global notices, README and recovery docs.

**Contract:** distinguish “bundle checksums verified,” “database integrity checked,” “stored tokens decrypt with bundled key,” and “restore rehearsal succeeded.” Do not promote a checksum/key-fingerprint match into decryption evidence. Perform local token validation using established encryption code with synthetic tests, without bank requests or token logging. Handle no-token databases explicitly.

Promote stale/failed sync and backup warnings near financial summaries. Include useful timestamps and next actions without exposing private paths or secrets. Document the trusted-local-host boundary, unencrypted financial database, and key-bearing recovery bundles. Preserve current remote authorization; adding a second application login is outside this increment unless the user's threat model changes.

**Acceptance:** wrong key with otherwise valid manifest, corrupt DB, missing config, no tokens, stale successful backup, latest failed attempt, and unavailable status all get accurate labels. Existing Host/Origin/Tailscale/CSP/no-store protections and safe diagnostic logging remain covered.

### P13 — Implement encrypted backup export and an isolated restore rehearsal

**Depends on:** P12.

**Contract:** add an operator-only CLI for encrypting a verified complete recovery bundle to a configured destination using an established tool such as `age` recipient encryption. Do not invent cryptography or expose arbitrary filesystem destination parameters through the browser. Prefer recipient public keys; keep decryption secrets outside bundles and source. Missing tool/key/destination produces an actionable failure and leaves existing backups intact.

**Subtasks:** P13a optional encryption-tool adapter and atomic export; P13b decrypt/verify/restore rehearsal into a fresh destination; P13c status and operational runbook. Tests use generated synthetic keys and temporary destinations only. Do not install tools, mount owner storage, configure a cloud destination, or enable a timer as part of implementation.

**Acceptance:** ciphertext does not expose synthetic plaintext markers; correct key restores exact IDs, cents, and token decryption; wrong key/corruption/ENOSPC/interruption fails safely; existing destination refuses overwrite. Record measured rehearsal duration and backup age. A second directory on the same disk is only a test destination, not proof of separate-device protection.

Deployment handoff must record owner-selected destination, acceptable data-loss window, and restoration-time target before claiming disaster recovery readiness. Code may pass synthetic acceptance while those external choices remain NOT_RUN.

### P14 — Add a complete portable financial export

**Depends on:** P07–P10.

**Contract:** export a versioned snapshot with stable IDs and relationships for accounts/observations, transactions, categories, budget records/history, goals/allocations, property/mortgage data, scenarios, and reconciliation records. Exclude provider tokens, credentials, configuration secrets, and raw replay request payloads. Keep transaction CSV as a separate report.

Take one consistent repository revision. Avoid a mixture of pages from different revisions; either use a consistent snapshot or reject the export on revision change. Bound memory use and surface failure before offering an incomplete download.

**Acceptance:** synthetic round-trip validation in an isolated importer/checker preserves IDs and exact cents, references resolve, unknown schema versions fail, concurrent changes cannot mix revisions, and sentinel credentials do not appear. A production restore/import UI is outside this task; do not silently add one.

### P15 — Final product acceptance and handoff

**Depends on:** P00–P14.

Run a clean synthetic owner journey: empty app → add/import account data → establish opening observation → plan selected month → categorize → recover an uncertain save after reload → reconcile → inspect/revert budget history → export → rehearse recovery.

Run in the reviewed disposable source copy:

```sh
npm ci
npm run check
npm run check:local-http
npm run check:browser
npm run check:browser:harness
npm audit --json
```

Also run the new focused cases because `check:browser` does not automatically imply every selectable case ran. Run migration/replay/reconciliation/export/recovery cases added by this plan. Use the existing release preparation/check scripts only with a disposable synthetic commit and explicit temporary release root. Do not activate the release.

Check reviewed diffs for whitespace/errors, and scan authorized changed/untracked source for secrets. `check:source` inspects the Git index and is not proof that all dirty/untracked content was scanned; never stage files to expand its coverage. State scan exclusions explicitly. Do not claim a full repository privacy review while protected documents remain excluded.

Update README current-state claims and the execution log. Capture source identity, schema version, commands/results, known limitations, and a concise next-action list. All A–C P1 defects must be resolved before declaring code acceptance complete. Existing automated pass evidence must not be presented as live bank accuracy, device-loss recovery, or human accessibility approval.

Code acceptance can be complete with external deployment gates explicitly NOT_RUN. Do not label the deployed service upgraded or the whole finance system trustworthy merely because code acceptance passed.

## Follow-on increment: P16–P17

### P16 — Transaction splits and reimbursement review

Only after A–C. First define immutable parent transactions plus category allocations whose signed integer cents sum exactly to the parent. Parent facts and provider sync identity remain authoritative. Spending reports count either allocated children or the unsplit parent, never both; account reconciliation still counts the parent once. Preserve an Other remainder or reject incomplete splits explicitly. Version/replay split edits and audit them. Handle provider corrections by flagging the split for review rather than silently adjusting amounts. Refunds retain their sign; reimbursement linking is an explicit reviewed relationship, not automatic income/transfer reclassification.

Deliver in subtasks: shared model/calculation; persistence/API; reporting/export parity; UI. Acceptance covers partial refunds, mixed-sign validation, split/unsplit undo, pending replacement, provider corrections, exact totals, and reconciliation neutrality.

### P17 — Recurring commitments and dated cash-flow planning

Only after reconciliation and splits are stable. Begin with explicit user-entered commitments and due dates; detection may suggest candidates but cannot create obligations without confirmation. Keep monthly set-aside conventions separate from actual dated payments. Do not multiply weekly commitments by four when generating a calendar payment schedule; enumerate real due dates while retaining weekly × 4 for the budget convention. Distinguish expected payment, observed transaction, and user-confirmed match. Avoid counting the same obligation in both forecast and actuals.

Deliver in subtasks: commitment model; deterministic calendar/forecast; reviewed matching; UI and reminders. Acceptance covers five-week months, annual due dates, leap years, end-of-month behavior, skipped/cancelled payments, refunds, incomplete balances, and late/missing income. Any “available to spend” figure must identify its included accounts, known commitments, reserves, data freshness, and unresolved assumptions.

## Copy-ready execution prompt

> Execute `docs/PRODUCT_IMPLEMENTATION_PLAN_LUNA_HIGH.md` using Luna at high reasoning. Start by reading the plan and the new product review, then recheck the dirty worktree without reading the protected progress document. Implement Increment A, then B, then C in dependency order. Work sequentially through bounded subtasks and record evidence in `docs/PRODUCT_IMPLEMENTATION_EXECUTION.md`. Preserve existing work and security/financial invariants. Use only disposable synthetic fixtures and source copies. Do not deploy, access owner data, stage or commit the original checkout, or enable services. Run meaningful focused regressions and the increment gates; do not repeatedly rerun unrelated suites. Continue authorized work without routine confirmation. Report code acceptance separately from unrun manual/external deployment gates. Leave P16–P17 as explicitly unimplemented follow-on scope unless separately requested.
