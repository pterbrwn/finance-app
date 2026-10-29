# Finance app stability implementation handoff

Updated 2026-10-28 following a fresh working-copy review and synthetic verification. This is the active implementation plan. Historical companion evidence: [STABILITY_REVIEW_2026-10-27.md](STABILITY_REVIEW_2026-10-27.md).

## Current baseline and delivery sequence

The current candidate is HEAD `6d5fc0c` plus uncommitted worker, browser, styling, build, finance/browser-check changes and `shared/budget-frequency.mjs`. Preserve these changes; record file hashes before implementation. Findings apply to this candidate, not automatically to the deployed release.

Fresh checks on 2026-10-28 used a disposable source copy, Node 24.22.1, existing installed dependencies, and synthetic fixtures:

| Check | Result | Consequence |
| --- | --- | --- |
| `npm run check` | PASS | Build, artifact, finance, budget, local storage, SQLite, backup and runtime fixtures execute successfully. |
| `bash scripts/run-node.sh scripts/check-dev.mjs --http` after build | PASS | Existing HTTP/access-control/persistence cases pass. |
| `npm run check:browser` | FAIL at `scripts/check-browser.mjs:245` | November recurring budget editor displays `0.00`, expected `75.00`, after October's zero override. Later browser checks are not certified. |
| Clean dependency installation, live bank connection, production recovery, full accessibility acceptance | NOT_RUN | Do not infer these from the synthetic checks. |

The browser failure response contains a recurring template amount of 7,500 cents and a zero override limited to October, but global category schedule metadata has `sourceAmount:0`. Preserve this as the first regression: fix schedule resolution/storage, not the expected $75 assertion. The previous review's broken-import and obsolete-locator failures have been superseded by this newer baseline; verify their current coverage rather than repeating completed repairs.

That table records the pre-implementation baseline. The recurring-budget defect has since been repaired; the latest full browser journey and independent recurring-budget cases pass, as recorded below and in the [execution record](STABILITY_EXECUTION_2026-10-28.md).

### Milestones

| Milestone | Ordered tasks | Exit criterion |
| --- | --- | --- |
| M0 — Reproducible checks | S00 | Independent regression cases, retained failures, source identity, and an accurate baseline. Existing product failures remain visible. |
| M1 — Trustworthy budgets and screen state | S03 → S04 → S05a/S05b → S01 | The $75 next-month case, historical schedule/reset cases, real two-tab conflicts, failed refresh and preview isolation all pass. |
| M2 — Correct classification and balances | S02 → S06 → S10 → S11; S07 → S08 → S09; S12; S21 | Correct income/transfers/allocations, preserved provider overrides and account metadata, valid observation/currency coverage, safe money/date inputs and enforced revisions. |
| M3 — Reliable daily use and recovery | S13a–c → S14; S16a–b; S17 | Lost responses cannot duplicate actions, drafts survive failures, exports are consistent, backups restore encrypted synthetic records and shutdown is bounded. |
| M4 — Performance and maintainability | S15a–c → S18a–c → S19 | Measured improvements, behavior-preserving extractions, and per-page/per-dialog usability evidence. |
| M5 — Release candidate | S20 | Integrated checks pass for the exact candidate; recovery/migration procedure and remaining manual checks are documented. |

Semicolons identify independent work streams, not an instruction to launch agents. Work sequentially unless delegation is explicitly requested. Earlier milestone repairs can form a separate stabilization candidate; deferred performance/refactor work must be listed explicitly. No candidate ships with an unresolved known high-priority correctness or sample-isolation defect. Every candidate runs S20, including relevant responsive and recovery checks for its changed behavior.

Start with S00, then S03. Keep the existing architecture; each patch should have a failing-before/passing-after regression and a bounded reviewable scope. A test harness improvement must not weaken product assertions to turn the baseline green.

## How to execute this plan

Implement **one task or named subtask per turn**. Read its files and relevant review finding, reproduce the defect, make the smallest complete fix, run focused checks, and record the result. Do not ask a cheaper model to “fix the whole finance app.” Carry the task ID, contract, fixture, and done criteria into each prompt.

Use the linked execution record for the current implementation and verification status; this plan defines each task's scope and acceptance contract. The initial baseline checks above do not establish that repairs are complete. Review probes are evidence of defects, not permanent regression coverage. Do not mark a task complete just because the current broad suite is green.

The implementation is in the uncommitted worktree. No original-checkout files were staged or committed, and no publication, live-data change, service activation, or deployment was performed. S19 still needs actual screen-reader and physical 200% zoom evidence; S20 still needs the authorized owner-specific privacy cleanup and final handoff signoff.

### Invariants and boundaries

1. Preserve existing unrelated changes. Baseline HEAD is `6d5fc0c`, with an unfinished frequency/allocation patch in worker, browser, styles, build, and the new frequency helper. Recheck status because the checkout may have advanced.
2. Use Node **24.22.1**, the lockfile, existing JavaScript modules, SQLite adapter, and Playwright installation. Do not upgrade dependencies or introduce a framework as a test repair.
3. Use synthetic fixtures in a disposable source copy. Never point tests at the private runtime directories, load owner configuration, contact a bank, enable a timer, or restart the live service.
4. Money is integer cents. Positive transaction amounts represent outflow. Pending/non-USD rows do not enter USD totals. Refunds reduce spending. Income and Transfers are valid transaction categories. Allocation-only buckets are planning records, not expenses or transaction categories.
5. Preserve the owner's explicit **weekly × 4** budget convention. Semiannual ÷ 6 and annual ÷ 12 produce monthly set-asides with documented cent rounding. Due month is metadata; do not invent a catch-up funding algorithm.
6. Preserve stable record IDs, null versus zero, original provider facts, overrides, historical budget boundaries, and saved history. No silent rewrite of owner records or destructive schema migration.
7. A revision belongs to the snapshot being edited. Do not attach a newer revision to stale values and do not silently retry a conflicted mutation against fresh state.
8. Sample mode uses synthetic data throughout and performs zero persistent writes.
9. No private names, balances, addresses, credentials, origins, or recovery paths in committed reports, fixtures, screenshots, logs, or prompts. R17 identifies an existing pending documentation issue.

### Safe test setup

Follow the source-copy instructions in [AUTOMATED_TESTING_PLAN.md](AUTOMATED_TESTING_PLAN.md), updated for the actual files present. Copy reviewed working-tree source, `package.json`, lockfile, and `.node-version`; include new modules. Exclude private artifacts, Git metadata, generated output, and owner data. Build only inside the copy.

```sh
export LEDGER_NODE_BIN="$HOME/.local/share/ledger/runtimes/node-v24.22.1/bin/node"
export PATH="$(dirname "$LEDGER_NODE_BIN"):$PATH"
node --version
# Run in the disposable source copy, after installing the locked dependencies there:
npm run build
```

The current candidate has passed a clean lockfile installation and source-copy release rehearsal under Node 24.22.1, recorded in the execution log. If a sandbox blocks loopback or child processes, distinguish the environment failure from an app failure and use an authorized synthetic-only execution environment. Do not weaken checks to accommodate sandbox errors.

For exploratory servers, use a fresh mode-0700 root and mode-0600 config `{"storageMode":"sqlite","enablePlaid":false}`, explicit `LEDGER_LOCAL_DATA_DIR` and `LEDGER_CONFIG_FILE`, and `PORT=0 bash scripts/start-ledger.sh`. Capture the child PID and printed URL. Stop that child and await exit. Retain synthetic failure artifacts outside the deleted state directory.

### Standard task completion record

```text
Task / subtask:
Candidate commit + intended working-tree changes:
Status: PASS | FAIL | BLOCKED | NOT_RUN
Failing reproduction before change:
Changed files and resulting contract:
Commands and exit status:
Backend / runtime / reporting date / browser viewport:
Evidence path and independent expected values:
Remaining cases / next task:
```

Append only code-safe results to `docs/IMPLEMENTATION_PROGRESS.md` after R17 cleanup, or keep a new code-only execution log until that cleanup is complete. Preserve historical records of what actually ran; do not label skipped tests as passed.

## Task dependencies

Use the milestone sequence above for execution; task IDs remain stable for existing references.

| Task | Priority | Depends on | Bounded result |
| --- | --- | --- | --- |
| S00 | P1 | — | Reliable baseline and usable regression harness |
| S01 | P1 | S00 | Sample preview cannot show saved data or write it |
| S02 | P1 | S00 | All transaction editors support the intended categories |
| S03 | P1 | S00 | Refresh keeps a coherent last-known snapshot |
| S04 | P1 | S03 | Budget snapshot and revision remain consistent |
| S05 | P1 | S04 | Schedule metadata is effective-dated with its amount |
| S06 | P1 | S02, S05 | Allocations have consistent totals and outlook behavior |
| S07 | P1 | S00 | Manual account updates preserve omitted settings |
| S08 | P1 | S07 | Observed-date eligibility rejects future cash |
| S09 | P1 | S08 | Mortgage fallback respects USD and observation coverage |
| S10 | P1 | S02 | Sync preserves override identity |
| S11 | P2 | S02 | Undo respects later edits |
| S12 | P2 | S04 | User-edit revisions are required consistently |
| S13a–c | P1 | S01–S12 | Draft, conflict, double-submit, and uncertain-save recovery |
| S14 | P2 | S03, S12 | Export has one consistent revision |
| S15a–c | P2 | S05, S06, S10 | Measured performance improvements with parity |
| S16a–b | P2 | S00 | Restorable private database/key recovery bundles |
| S17 | P2 | S00 | Safe diagnostics and bounded shutdown |
| S18a–c | P2 | S01–S13 | Small behavior-preserving module extractions |
| S19 | P2 | S05, S06, S13 | Responsive and accessible page/dialog acceptance |
| S21 | P2 / P1 if incorrect ordinary results reproduced | S00 | Explicit money, date-range, and amortization contracts |
| S20 | P1 release gate | All shipping tasks | Clean source boundary and integrated candidate evidence |

S01–S12 and S21 comprise correctness stabilization across M1 and M2. S13 is required before calling mutation recovery stable. Later work can be shipped in separate candidates when its dependencies and acceptance gates pass. No broad refactor is a prerequisite for fixing the confirmed defects.

## S00 — Repair and preserve the verification baseline

**Read/change:** `scripts/check-finance.mjs`, `scripts/check-browser.mjs`, `package.json`; build asset list in `scripts/build.mjs`. Findings R14, R17.

1. Record the exact source candidate and current failures. Capture stdout/stderr and test environment without copying private configuration.
2. Verify the already-passing finance harness handles the frequency-module import explicitly and catches unhandled imports. Preserve the repair; do not blanket-delete imports or leave globals undefined.
3. Preserve the current recurring-template browser assertion. Extract its October-zero/November-$75 sequence into an independent case with fresh SQLite. Add historical annual/monthly/reset and two-tab cases for S04/S05. Existing category-dialog checks already advance past the older locator failure; change them only if new evidence requires it.
4. Add bounded failure cleanup and retained screenshot/trace/console metadata. A single deliberately injected synthetic page error must fail the runner; a deliberate assertion failure must leave artifacts after cleanup.
5. Add a documented selector for independent browser cases/groups while preserving the existing full command. Start with the regressions needed by S01–S04. Names such as `BROWSER_CASE` are proposals until actually implemented.

**Current harness commands:** `npm run check:browser` runs the full journey. Set `BROWSER_CASE=sample-isolation`, `budget-recurring`, `budget-frequency-history`, `budget-two-tab`, `form-drafts`, `form-cancel`, `refresh-edit`, `snapshot-races`, `operation-restart`, or `accessibility-tree` with `npm run check:browser:case` to run one fresh synthetic SQLite case. `form-drafts` checks named forms through revision conflicts and JSON/HTML failures, useful focus restoration, bulk-category failure retention, replay-safe retries, and a repeated keyboard Enter submit. `form-cancel` cancels the import, category, scenario-create, manual-account, goal, allocation, property, and mortgage dialogs, including tested edit dialogs, and verifies no mutation or revision change. `refresh-edit` delays a successful refresh while a separate form draft is edited. `snapshot-races` delays older search/month queries; `operation-restart` drops committed manual-account, nonmanual-account update, category create/rename, scenario, goal, property, mortgage, monthly budget, budget reset, monthly income-plan, income-plan reset, budget-outlook, CSV-import, single-transaction category, bulk-category, goal-allocation, scenario-to-goal, scenario-to-budget, mortgage-update, allocation-undo, bulk-category-undo, and import-undo responses, restarts the local synthetic server, and verifies exact replay and persisted state. It also verifies balance-snapshot read-back without a duplicate. `accessibility-tree` queries Chromium's accessibility tree for all eight main views, transaction/budget row and cell semantics, and category/import dialog names and controls. `npm run check:browser:harness` injects a page error and an assertion failure and verifies both fail promptly with private screenshot, trace, request, and console artifacts; its temporary artifacts are deleted after the self-check.

**Done:** Finance harness executes; each targeted group runs independently with fresh SQLite; unexpected page/console/API failures fail its case; the full browser runner reports per-case product failures honestly. The original $75-versus-$0 recurring-budget regression is retained and now passes after S04/S05 repairs in both its independent case and the full browser journey. Existing candidate defects may still fail product acceptance. Record them, then continue with their tasks.

**Checks:** build, `scripts/check-finance.mjs`, new harness self-checks, affected browser group. Do not repeatedly run the entire journey after every harness edit.

## S01 — Isolate sample preview

**Read/change:** `ui/browser.js` (`render`, `overview`, `balanceSheetPanel`, `planningCommitments`, `banksPage`, `api`, demo enter/exit); browser regression. R10.

Use one explicit sample view model for accounts, balances, goals, properties, snapshots, and summaries, or omit unsupported sample sections. Add a central guard at the mutation boundary so a missed click-handler condition cannot POST while previewing. Keep sample-only budget/category edits local. Entering/exiting sample must invalidate or safely ignore incompatible in-flight responses.

**Fixture:** Persist one uniquely named synthetic account and record its state revision/hash. Open sample and visit every destination. Attempt every available action, especially Record snapshot, imports, connects, category edits, and account actions.

**Done:** No saved marker or saved amount appears in the sample DOM; zero persistence POSTs/provider actions; backing state and revision unchanged after sample actions; exit restores saved records. Include entering preview during a delayed request. Avoid implementing server-wide “sample mode” that would affect other real tabs.

## S02 — Repair visible transaction editing and category choices

**Read/change:** `ui/browser.js` (`assignableCategories`, `categoryOptions`, `bindCategories`), worker category and bulk routes, tests. R01, R09.

Create a consistent assignability predicate: active expense/income/transfer categories allowed; allocation-only and archived categories unavailable for new assignment. Existing archived labels remain displayable. Look up rendered rows by stable ID across paged rows and Overview recent rows; do not restore all-history bootstrap just for lookup.

**Fixture:** Ordinary purchase, misclassified payroll, card payment, and allocation-only custom bucket. Edit through Overview and Transactions; bulk-edit to Income and Transfers. Reload and check exact IDs plus totals. Test rapid same-row edits and a failed edit without silently announcing success.

**Done:** Correct POSTs, persistent final values, valid selected option for existing Income/Transfers, no allocation choices, correct spending/income after reload. Cover JSON/SQLite API parity and the actual SQLite browser controls.

## S03 — Commit refresh data atomically and guard stale responses

**Read/change:** `ui/browser.js` (`refresh`, `readLocation`, month change, `loadTransactionPage`, `loadBudgetSummary`, `reportSummary`). R11, R18.

Build a candidate snapshot locally; install it only when the required requests for that view/month succeed and its generation remains current. Preserve the previous snapshot on failure. Separate page-query errors from empty results. Do not let an earlier request update a later month, overwrite a draft, change preview mode, or lower an acknowledged revision.

**Fixture:** $100 purchase. Succeed state and fail monthly summary: saved $100 and row stay visible with stale/error status. Separately fail initial load: show unavailable, not $0 or demo. Delay request A, finish B, then release A across month, search, history back/forward, and refresh.

**Done:** Current URL, month, rows, summaries, revision, and status agree; rejected or failed snapshots never replace useful saved data. Retry recovers. Preserve focus/caret during valid search updates.

## S04 — Use an authoritative budget snapshot

**Read/change:** `ui/browser.js` (`loadBudgetSummary`, `budgetPage`, `budgetAmount`, Overview budget consumers); worker summary contract if necessary. R12.

Select one effective month snapshot containing all plan inputs and its revision. Remove fallback precedence that combines stale `data.budgetTemplates`/overrides/outlooks with fresh budget-summary actuals and revision. Keep independent global state explicitly separate. Retain unsaved drafts, but bind them to their original revision and require conflict handling before reapplication.

**Fixture:** Two clients load $100. B saves $200. A navigates back and must show $200, or preserve an explicitly stale draft that cannot overwrite without conflict. Repeat for income, month override, frequency, and outlook. A concurrent unrelated edit must survive.

**Done:** Same-revision plan/actual inputs; no silent stale overwrite. Browser test uses a real second client, not only a mocked 409.

## S05 — Version budget schedules with their amounts

**Read/change:** `shared/budgets.mjs`, `shared/budget-frequency.mjs`, worker budget/create/reset routes, SQLite migrations/repository, browser row editor, tests. R02.

Implement in two small patches if needed: **S05a storage/resolution**, then **S05b UI and restart acceptance**.

**Contract:** Each recurring template, keyed by category ID + effective month, and each month override owns `{amount, sourceAmount, frequency, dueMonth}`. `amount` remains derived integer monthly cents. Group/item type are separate category-level metadata. An explicit null amount remains unknown; zero remains known. Reset selects the full effective template, not just its amount.

Use an additive versioned persistence change. Legacy normalized templates with only `amount` become monthly plans with that source amount. Existing global schedule settings cannot reliably reconstruct historical source amounts; reuse them only when they demonstrably match a corresponding effective amount, otherwise retain correct historical cents and mark legacy monthly interpretation. Do not invent history or rewrite owner data during a test.

**Independent cases:** weekly 1,000 → 4,000; semiannual 70,000 → 11,667; annual 79,500 → 6,625 with required due month. October annual 120,000 → 10,000, November monthly override 20,000: October editor remains annual/120,000; reset November restores the full October template. Add future recurring changes, blank/zero, rejected schedules, rounding, historical boundary, migration rollback, JSON parity, SQLite close/reopen, and immutable asset inclusion.

**Done:** Source amount, displayed period, monthly result, and persisted effective month agree before and after reload/reset. Reject invalid input with 400, not an uncaught browser exception. Preserve four-week policy.

## S06 — Separate allocations from spending

**Read/change:** worker category catalog/import/budget summaries/outlook, `shared/budgets.mjs`, repository month summaries where needed, browser budget/Overview fields, tests. R03.

Define the shared result explicitly: `plannedExpenseTotal`, `plannedAllocationTotal`, expense actuals/outlook, and `remainingAfterCommitments`. Both expense plans and allocations reduce planned available income. Allocation amounts never inflate actual or expected **spending**. If the UI shows money remaining after allocations, label that result separately from net cash flow.

Exclude allocation-only categories from transaction editors and CSV target mapping. For existing allocation-tagged transactions, adopt one consistent documented compatibility rule in all reports; recommended: treat explicitly identified allocation kinds as transfer-like non-spending while preserving original stored rows and showing the classification. Do not guess based on the display name. Flag unknown historical categories for review.

Outlook controls and payloads contain only valid expense categories. Allocation expectations must not make the entire save fail. Validate any configured `actualCategoryIds`: no self-reference, cycles, duplicate counting, or overlapping membership without an explicit deterministic rule. Do not build an unsolicited grouping editor.

**Fixture:** income $1,000, expense plan $100, allocation $50, actual expense $40. Planned expense $100, allocation $50, remaining after plans $850, actual spending $40. Outlook expense defaults to $100; any $50 allocation deduction is separate. With an imported historical allocation transaction, Overview and Budgets spending agree. Save/reset outlook, rename/archive, carryover, and reload.

**Done:** All report views reconcile to independent arithmetic; no allocation field reaches an expense-only API; existing data survives.

## S07 — Preserve manual-account metadata on edit

**Read/change:** `/api/manual-account`, `manualAccountDialog`, finance/SQLite/browser cases. R07.

Apply defaults only to newly created records. On edits preserve omitted `includeInReporting`, `subtype`, and other fields the form does not edit; validate explicit values separately. Keep archive/restore an explicit action rather than unarchiving incidentally through unrelated edits.

**Fixture:** Excluded cash account with subtype `cash`; rename/change balance through dialog. Exclusion and subtype persist after reload, and net worth/goal cash do not suddenly include it. Explicit Include works. Check unchanged institution/notes according to the form's actual submitted contract.

## S08 — Validate observed dates and cash freshness

**Read/change:** `shared/goals.mjs`, `shared/net-worth.mjs`, worker manual account/property/mortgage validation, date helpers, tests. R05.

Separate observed balances/valuations/statements from forecast/target dates. Reject future manual observations on write; legacy future observations remain visible but unavailable for verified present funding, with explanatory coverage. Choose a shared America/Chicago date-only freshness rule and keep instant timestamps distinct. Do not disallow future goal targets or scenario assumptions.

**Cases:** today, yesterday, expired observation, tomorrow, 2099, invalid/leap dates, Chicago/UTC midnight, missing date, unavailable provider timestamp, zero cash, negative available balance. Pass a fixed `asOf` to pure tests. Avoid changing the system clock.

**Done:** Future cash cannot back new allocations or scenario funding; all relevant views use consistent eligibility and stale wording.

## S09 — Validate mortgage-linked fallback balances

**Read/change:** `shared/mortgages.mjs`, `shared/net-worth.mjs`, `/api/mortgage` link validation, tests. R06.

Use a valid USD observed statement when supplied; otherwise use only an eligible USD linked liability observation with known amount, provenance, and freshness. Propagate linked-account observation time and coverage. Treat unavailable/foreign/excluded fallback as missing with partial coverage. Do not double-count the linked liability when a valid mortgage record represents it. Preserve partial ownership and explicit debt shares.

**Fixture:** $1,000 property, CAD 200 linked liability, no statement: do not report CAD 200 as USD debt; mark incomplete. Add current USD, stale USD, excluded, archived, unknown balance/date, manual USD statement with foreign link, and duplicate-link cases. Verify total debt and coverage both in pure functions and API response.

## S10 — Preserve category identity through sync

**Read/change:** `shared/reconciliation.mjs`, scoped SQLite sync persistence, finance/SQLite tests. R13.

Carry `{override, overrideCategoryId}` together from same-ID or pending predecessor. Preserve explicitly supported local metadata and keep provider fields authoritative. Do not copy arbitrary old provider fields over fresh responses. Category edits arriving before commit must survive because reconciliation reads the live state in the serialized mutation.

**Cases:** added/modified/pending-to-posted across both pagination orders, repeated sync, renamed custom bucket, removed row, missing ID legacy override, concurrent category save, failed write with unchanged cursor. Confirm stable-ID filter works after sync and database reopen. Use mocked provider responses only.

## S11 — Make undo operation-aware

**Read/change:** category mutation/bulk/undo routes, transaction schema/payload metadata as appropriate, tests. R08.

Add a per-transaction category-edit version or operation marker. Batch undo records the post-edit marker and checks it before reversing. All individual, bulk, and relevant reconciliation paths preserve/update it intentionally. Avoid comparing only display name or category ID. Return exact undone/skipped counts and keep later changes.

**Fixture:** bulk Shopping → individual Dining → individual Shopping → undo old batch. Final Shopping survives and is skipped. Also cover untouched row, deleted row, repeat undo, category rename, pending-to-posted, real revision conflict, and restart.

## S12 — Require revision contracts for user writes

**Read/change:** `checkRevision`, worker mutation callers, browser payloads, API tests. R04.

Inventory each mutation route. Require a non-negative safe integer expected revision for edits/undo; reject missing, malformed, and stale revisions consistently before effects. Keep provider/background operations on deliberate internal concurrency contracts rather than fabricating UI revisions. Keep idempotent operations' replay rules explicit. Never perform a provider side effect first and discover an avoidable local validation error afterward.

**Done:** Missing/stale revision cannot overwrite values; valid mutation advances once; rejected mutation advances zero times; both repositories agree. Update synthetic callers deliberately instead of making the check optional to appease tests.

## S13a–c — Complete save/recovery behavior

**Read/change:** affected browser form/state helpers and APIs; reuse the failure matrix F01–F07 in [AUTOMATED_TESTING_PLAN.md](AUTOMATED_TESTING_PLAN.md). R18.

- **S13a drafts and pending state:** Category create/rename/row/bulk, budget/income/outlook, manual account, goal/allocation, property/mortgage, scenario/apply forms. Preserve the full draft and useful focus across rerender, network error, 500 JSON, 502 HTML, and real conflict. Serialize or disable repeat submit including keyboard Enter. Do not store financial drafts in browser persistent storage.
- **S13b committed-response-loss:** Forward one create to the synthetic server, then lose its response. Implement stable client operation IDs and atomic server result replay for non-idempotent creates/applies where necessary. Same ID + same payload returns the same result; same ID + different payload conflicts. Provide read-back/recovery for uncertain saves. Preserve operation IDs through retries; do not auto-repeat bank token exchange or unlink.
- **S13c integration:** Race two tabs, reverse query completion, edit while a refresh completes, cancel dialogs, and retry. Verify exact record counts/IDs, unaffected records, totals, and revision after fresh context plus server restart.

**Done:** Each named form family has recorded cases. “Request aborted before delivery” is not evidence of handling “committed but response lost.” Use bounded case timeouts and retain first-run failures.

## S14 — Export a consistent dataset

**Read/change:** `exportCSV`, transaction query contract/repository, tests. R19.

Capture query/filter and starting revision. Require every page to belong to that revision or abort the export visibly before offering a download. A bounded restart option is sufficient initially; an unbounded whole-history response is not required. Preserve CSV formula escaping and all matching rows beyond the visible page.

**Fixture:** 121 unique matching IDs plus nonmatching rows and tied dates. Verify exact exported multiset. Mutate between pages and assert no mixed/duplicate/omitted download. Test empty export, failure, cancel, and Unicode/formula-like text.

## S15a–c — Measure and remove remaining expensive paths

**Read/change:** `scripts/measure-performance.mjs`, worker budget-summary/mutation paths, `server/sqlite-repository.mjs`, tests. R15, R20.

- **S15a measure:** Extend the existing synthetic benchmark with budget-summary, budget edit, goal/account edit, and state response with several long-term mortgages. Record 10k and 100k history, bounded month spans, response bytes, latency, event-loop delay, and memory. Keep the original baseline separate; do not claim historical numbers are current measurements.
- **S15b targeted persistence:** First remove unconditional all-history loading from category/edit validation, then scope metadata-only budget/account/goal mutations so they do not rewrite unrelated transaction tables. One route family per patch. Maintain transactional revision checks and JSON contract parity. Instrument SQL to verify unrelated transaction rows are untouched.
- **S15c bounded summaries:** Query monthly category activity/amounts through SQLite and compute carryover from bounded effective history. Include zero-net purchase/refund activity, grouped categories, all overrides, negative carryover, and history boundary. Cache only with explicit revision/month keys and invalidation. Avoid returning full amortization schedules in routine bootstrap when a summary plus explicit detail endpoint suffices.

**Done:** Same fixture IDs, totals, and atomic failure behavior; benchmark comparison shows improvement without new memory/latency regressions. Reuse existing response/latency targets where applicable; agree new budget-specific thresholds from S15a measurements rather than inventing universal numbers. Add safe integer and date-range bounds where the measured path requires them. Do not optimize before fixing correctness.

## S16a–b — Make recovery complete and testable

**Read/change:** backup runner/retention/restore, private configuration handling, recovery guide, synthetic backup tests. R16.

- **S16a design and bundle:** Version a private recovery manifest pairing database checksum/schema/build identity with the corresponding configuration/key version. Store secret-containing recovery material only in mode-0600 private storage with mode-0700 directories. Make publication atomic and coordinate config changes/backup so a bundle cannot pair the wrong key. Retention treats the set as a unit and preserves unknown/migration artifacts. Manifest/log/status output must not reveal key or record values.
- **S16b rehearsal:** Restore into a new temporary destination, validate SQLite, decrypt a synthetic saved token with the paired test key, compare exact synthetic IDs and aggregate totals, and demonstrate wrong-key/missing-config/corrupt-copy failures. Test ENOSPC/permission failure and interrupted backup without losing the last good set. Existing destinations remain protected.

**Done:** “Backup success” distinguishes database-only from complete recoverability. Add clear age/stale status. Document optional offline encrypted copies without selecting a destination or uploading owner data. Actual owner recovery/cutover remains a separately authorized operation.

## S17 — Add safe diagnostics and graceful shutdown

**Read/change:** `scripts/dev-server.mjs`, `scripts/runtime.mjs`, worker error boundary/sync lifecycle, repository close, tests. R21.

Log bounded request/operation IDs, route, error class/code, and duration without bodies, merchant text, tokens, configuration, private headers, or full SQL values. Keep browser errors readable. On shutdown stop accepting new work, finish/interrupt sync coherently within a documented deadline, drain serialized writes, and close the repository. Test SIGTERM during synthetic mutation/sync and restart recovery. Cache systemd timer checks briefly and expose checked-at/unavailable status honestly.

**Done:** An injected failure can be diagnosed by safe codes; secret-canary fixtures never appear in logs; restart leaves no half-applied mutation and no permanently running sync job.

## S18a–c — Reduce maintenance cost without redesign

**Depends on regression coverage. Read/change:** worker/browser/shared modules and build allowlists. R15.

- **S18a:** Format the functions involved in prior repairs, then extract budget resolution/presentation preparation into pure shared helpers with explicit inputs. Separate formatting from semantic changes for review.
- **S18b:** Extract browser request/view-state and dialog submission helpers, one concern at a time. Retain ESM/static CSP and exact API behavior. Do not introduce a UI framework, bundler, TypeScript conversion, or broad state-library migration.
- **S18c:** Extract worker route families behind existing authentication/origin/owner/error guards and repository boundaries. Start with budgets; preserve endpoint contracts and mutation serialization. Remove duplicate fallbacks only with contract parity evidence.

**Done:** A cheaper model can edit one feature without reading giant unrelated functions; no changed financial output or persistence semantics; generated asset allowlist and render tests cover every new module. Run relevant regressions plus one integrated gate after the final extraction.

## S19 — Validate everyday usability and accessibility

**Read/change:** browser markup/styles, independent browser groups. R22.

Matrix: Overview, Transactions, Budgets, Accounts, Investments, Goals, Home, Settings; creation/edit/import dialogs; 1440, 390, 320, and 720 CSS px. Check dense periodic-budget inputs, long category names, focus restoration, keyboard order, visible pending/errors, selection across pages, filter/history behavior, and 44 px navigation targets. Assess row/cell semantics with the actual accessibility tree. Keep visual changes local to proven problems.

Run serious/critical Axe checks per case with failures tied to page and viewport. Clearly label 720 CSS px as a viewport proxy. Screen-reader use and physical 200% zoom need separate evidence and must remain NOT_RUN if unavailable.

**Done:** Per-page and per-dialog results, retained failure evidence, no misleading full-accessibility claim from a single scan or final-view width loop.

## S21 — Bound money/date inputs and expose balloon payments

**Read/change:** `shared/money.mjs`, provider amount conversion in `shared/reporting.mjs`, aggregate/projection helpers, `shared/mortgages.mjs`, worker input validation, focused tests. R20. These are identified boundary risks, not all freshly reproduced failures.

1. Inventory supported monetary and reporting-date ranges. Enforce safe integer cents at input, conversion, addition, and projection boundaries; reject overflow before persistence and surface unavailable calculations rather than plausible rounded totals. Keep Decimal-based calculations where already required. Use independently computed boundary expectations.
2. Bound reporting months and carryover replay consistently in HTTP validation and pure helpers. Base the supported range on existing history and explicit product requirements; do not silently truncate records. Reject unreasonable requests with a useful error before expensive work.
3. Reproduce an undersized but principal-reducing `scheduledPayment` with a fixed term. The current amortizer pays all remaining principal in its last period. Either expose that final amount explicitly as a balloon with matching labels/totals, or reject the unsupported schedule. Do not present it as an ordinary fully amortizing payment. Preserve ordinary cent-rounding adjustments.

**Cases:** safe-integer limit and overflow, tiny/negative/refund values, non-finite provider amounts, long projections, extreme reporting month, normal loan rounding, undersized payment, zero interest, and extra principal. Verify rejection leaves records/revision unchanged and that unsupported results are understandable in the UI.

**Done:** Documented bounds are shared by API and calculation layers; no silent wrap/precision loss, unbounded replay or hidden material final payment. Ordinary supported calculations retain exact expected cents.

## S20 — Final source and release-candidate handoff

1. Sanitize the pending owner-specific progress text identified in R17; preserve code-only facts and historical status. Do not include private values in commit diffs or PR text. Review untracked files explicitly. No changes to private runtime data.
2. Update README/current-state documentation to distinguish current implementation, passed checks, remaining gaps, and historically deployed builds. Link this plan as the active stability queue; do not duplicate obsolete plans as competing sources of truth.
3. Run a clean dependency install and build in a fresh source copy. Record candidate commit + working-tree manifest. A future immutable release must be built from a committed candidate that includes required new modules; preparing HEAD alone would omit today's unfinished patch.
4. Run the integrated commands below once after the final source change. Keep focused checks during development; repeat the whole suite only for a new change or failure.
5. Review release preparation/activation/rollback using synthetic targets and stub systemd as existing package tests do. For S05 schema changes, rehearse migration of a legacy fixture, restart, interrupted migration, and recovery into a separate destination. A code symlink rollback alone is not a database downgrade; retain a paired pre-migration recovery bundle and document the compatible schema/code pair. Verify matching build/schema/assets and failed-activation preservation. Do not activate the live release under a review-only instruction.

```sh
npm run check
npm run check:local-http
npm run check:browser
git diff --check
# In the actual Git checkout, with an explicit understanding that this checks the index:
npm run check:source
```

Inspect actual changed/untracked content separately; never stage files just to make the boundary checker include them. Run the existing Gitleaks hooks in an authorized commit workflow; index scanning alone is not a secret/privacy audit. Dependency advisory status remains unverified until an actual audit is run and recorded; upgrade only through a separate compatible, tested change.

**Release-candidate done:** All mandatory shipped tasks pass; exact commands/backends/fixtures and unrun manual/external checks are recorded; no unresolved P1 correctness defect is hidden; rollback/recovery steps refer to the candidate's actual schema. Report implementation completion separately from live deployment acceptance.

## Copyable prompt for the next model

> Implement task S00 from `docs/STABILITY_IMPLEMENTATION_PLAN.md`. Read the companion review and current Git status first. Preserve unrelated working-tree changes. Use Node 24.22.1 and a disposable synthetic source copy; never use live Ledger configuration or records. Use the 2026-10-28 baseline: the main and HTTP suites pass; browser acceptance fails on a $75 next-month recurring budget displayed as $0. Preserve completed harness repairs, extract independent regression cases without weakening assertions, retain failure artifacts, and run the task's focused checks. Update a code-only execution record with changed files, exact results, remaining failures, and the next task. Do not commit, deploy, enable bank sync, upgrade dependencies, or begin a broad refactor. Stop after S00 is concrete and reviewable.

For subsequent turns replace S00 with the next task or named subtask and include its prerequisite results. For a multi-step task such as S05, S13, S15, S16, or S18, select its first unfinished subtask rather than starting every subtask simultaneously.
