# Finance app implementation progress

Code-only log. No production records, account names, credentials, private origins, or balances belong here.

## T00 — Safe implementation baseline

**Status:** Complete. Source baseline, synthetic test baseline, and private backup/restore rehearsal are recorded.

- Baseline commit: `9e5428d`.
- Implementation branch: `codex/finance-app-plan`.
- Existing uncommitted changes in `worker/index.js` contain partial investment, holdings, custom-category, and manual-account behavior. Preserved in the working tree; reviewed as incomplete and not deployed.
- Ran `npm run check` in a disposable source-only copy: build, artifact validation, finance checks, and local storage checks passed.
- Ran `npm run check:local-http` in a disposable source-only copy: local server, access guards, synthetic CSV import, concurrency, and restart persistence checks passed.
- The running `ledger.service` uses `/usr/bin/node scripts/dev-server.mjs` from the checkout and is active; `ledger-sync.timer` is inactive. The installed runtime is Node 20.20.2 on ARM64.
- The service has no version health endpoint. Its current generated artifact predates T01 and has no version metadata; the review records the deployed baseline as `9e5428d`.
- Created a private paired backup of the production JSON state and config/key, mode `700` directory and `600` files, with a checksum-only manifest. Copied it to an isolated restore directory, parsed both files, decrypted every stored token with the paired backup key, and removed the temporary restore copy. The active service was not interrupted.

## T01 — Pending-to-posted reconciliation

**Status:** Complete. Commit: `e4e1258`.

- Added `applySyncPages` to aggregate all page additions, modifications, and removals before applying the update, preserving overrides when a pending transaction is removed on one page and its posted replacement arrives on another.
- Added regression coverage for both page orders.
- Ran the focused regression check and the full finance and isolated HTTP suites; all passed.

## T02 — Safe runtime and release operations

**Status:** Complete. Commit: `6b411d9`.

- Installed Node.js `24.22.1` in the application-owned runtime directory after verifying the official ARM64 archive checksum. `/usr/bin/node` remains unchanged.
- Added an application startup wrapper that holds a non-blocking `flock` for the data directory; direct server starts fail unless launched through that wrapper. The sync timer uses the pinned runtime and talks to the active service.
- Added build/schema health metadata, immutable release preparation from committed Git source, and atomic activate/rollback symlink scripts. Updated service units to use the current release path; they have not been installed or activated.
- Finance, artifact, storage, and HTTP suites passed in a disposable source-only copy under Node 24, including a second-writer rejection check.
- Prepared and launched a release in a synthetic environment, confirmed the health code version, activated and rolled back symlinks, and confirmed an invalid release leaves the active synthetic symlink intact.

## Existing unfinished patch

**Status:** Preserved on the implementation branch as a separate review unit. Commit: `6d31831`.

- The commit contains the pre-existing partial investment, holdings, custom-category, and manual-account changes from `worker/index.js`.
- The review confirms the patch lacks complete UI, stable account/category identities, and feature-specific coverage. It remains an implementation input for T09 and has not been activated.

## T03 — Modularize without redesigning behavior

**Status:** Complete. Commit: `fcc847a`.

- Extracted pure money, reporting, investment-account, holdings, transaction-reconciliation, and storage-repository modules.
- Built the standalone output as an ESM module tree instead of concatenated source. The local runtime now depends on the repository interface rather than the bucket adapter.
- Moved browser code and styles to a strict static asset allowlist. The HTML shell has no inline script, script CSP no longer permits inline code, and traversal requests return 404.
- Finance, storage, API, client-render, static-route, access-control, concurrency, and HTTP checks passed under Node 24 in an isolated source copy.
- Prepared and launched a synthetic release, confirmed versioned health and static assets, and verified activation, rollback, and failed-activation preservation.

## T04a — SQLite adapter and recovery commands

**Status:** Complete. Commit: `eaa9b51`.

- Verified `better-sqlite3@13.0.3` loads and executes SQLite 3.53.4 on the host's Linux ARM64 / Ubuntu 22.04 / GLIBC 2.35 environment under pinned Node 24.22.1. `decimal.js@10.6.0` and the lockfile are pinned.
- Added schema migration 001, a local SQLite repository with foreign keys, WAL, 5-second busy timeout, atomic state writes, normalized record tables, and a configuration-selected adapter. JSON remains the active default until migration gates are explicitly completed.
- Added SQLite online backup and verified restore commands. Release preparation installs production dependencies from the committed lockfile into each immutable release.
- Tested constraint failure rollback, integrity and foreign-key checks, backup API output and permissions, and restore in a disposable synthetic directory.
- Full finance, storage, artifact, SQLite, and isolated HTTP checks passed in a disposable source-only copy under Node 24.
- Prepared the committed release and loaded its ARM64 native binding. No production symlink, service, or storage setting was changed.

## T04b — Explicit legacy importer

**Status:** Implementation complete. Importer commit: `65aa7f4`; serialized-write follow-up: `8c217a8`. Production acceptance gates remain pending.

- Added an explicit JSON-to-SQLite import command. It validates JSON shape and relational constraints before commit, computes and records the exact source checksum, and refuses to merge into a populated database.
- It verifies encrypted token/IV pairs locally using the existing AES-256-GCM key, then preserves their original ciphertext, IV, provider cursors, record IDs, category overrides, balances, and budget limits. It never prints token/config values.
- Missing product/environment fields remain missing. The importer reports how many items have unspecified environment and does not infer production or sandbox from the private config.
- Same-source reruns are idempotent. Synthetic checks verify key preservation, unknown environment handling, counts, idempotency, integrity, foreign keys, backup/restore, and transaction rollback.
- SQLite writes are serialized in-process; a concurrent-update regression check proves independent budget changes are retained.
- No production database was created or activated. The live service continues to use the original JSON state.
- The required private production aggregate comparison and operational restore rehearsal remain release gates. The fixture suite does not substitute for those checks.
- The local SQLite adapter now exposes schema version 2 with normalized recurring-template and monthly-override tables. A pre-existing version-1 database is backed up through the online SQLite backup API before migration 002, verified, then migrated; failed backup verification stops the migration.

**Next:** T05, explicit app states and usable navigation. SQLite remains opt-in; do not select it in production before the golden-data and restore gates pass.

## T05 — Explicit app states and usable navigation

**Status:** Complete. Commit: `cc273d1`.

- Removed automatic demo selection based on the absence of linked items or transactions. New users see an honest empty state with saved account/budget information; synthetic data requires an explicit preview action and has a persistent exit control.
- Added loading, initial error, failed-refresh/stale, and linked-but-importing messages. Errors do not replace real balances with sample data.
- Added Overview, Transactions, Budgets, Accounts, Investments, Goals, Home planner, and Settings navigation. Unimplemented areas state that they are empty/in preparation rather than showing fabricated values.
- Page and transaction filters are reflected in the URL and browser history. Query inputs are bounded; the month parameter is validated. Narrow screens use a horizontally scrollable navigation row with 44 px touch targets.
- Category and budget saves provide inline status and restore keyboard focus after rendering.
- Finance/browser checks cover empty, budget-only, manual-only, linked-but-importing, initial-error, explicit demo, and hostile month-query states. Full finance, SQLite, and isolated HTTP suites passed in a disposable source copy under Node 24.

**Next:** T06, custom categories and budget buckets.

## T06 — Saved custom categories and budget buckets

**Status:** Complete. Commit: `e943a71`.

- Added stable IDs and expense kinds for custom buckets, plus stable generated IDs and protected kinds for built-in Income and Transfers.
- Added create, rename, move, and archive APIs. Renaming retains the category ID, updates budget labels and existing assignments, and preserves the previous source category where needed. Archived categories remain selectable on historical transactions but are excluded from new assignments.
- Added creation from Budgets and Transactions, an optional monthly limit, custom category filtering/editing, and a custom-category manager with rename, order, and archive controls. Labels are HTML escaped.
- Legacy string categories receive deterministic IDs when first read and are materialized on mutation. Demo edits remain confined to the explicit synthetic preview.
- State revisions now increment atomically for writes. Category assignment, bucket create/rename/archive/order, and budget saves can require the observed revision; stale edits return 409.
- Finance tests cover ampersand names, normalization conflicts, stable IDs, assignment/budget rename, archive history, and stale category/budget edits. Full finance, SQLite, and HTTP suites passed in an isolated Node 24 copy.

**Next:** T07, monthly template/override semantics and budget UI.

## T07 — Monthly budget semantics

**Status:** Complete. Commit: `ee414ce`.

- Added shared month validation and budget resolution. A month override wins (including explicit `null` no-limit and `0`), otherwise the most recent recurring template effective on or before the selected month applies.
- Legacy monthly limits become templates effective from the current `America/Chicago` month. Earlier history is marked unavailable; no snapshots are invented.
- Added SQLite migration 002 for recurring templates and month overrides; local storage round-trips zero and null values. Existing schema-v1 databases get a verified private online backup before migration, and health reports the SQLite schema version.
- Added month-specific override, override reset, and effective-dated template API writes. Updating a template preserves earlier periods; edits use expected revisions.
- Budgets now show the selected month, template versus override, spent/remaining/overspent behavior, reset action, and distinct zero/no-limit states. The month selector includes transaction and budget months.
- Shared unit/API checks cover template roll-forward, month override, future changes, reset, zero and null. Browser smoke checks cover selected-month form states. Full finance, SQLite, and HTTP suites passed in isolated Node 24 copies.

**Next:** T08, generic account and connection management.


## T08 — Generic account and connection management

**Status:** Implementation complete. Acceptance checks pass in an isolated source copy; production remains on its prior release.

- Replaced the two hardcoded bank cards with a generic Accounts page and always-visible Add account flow for bank/credit, investment/retirement/HSA, manual accounts, and CSV imports. Optional LMCU, Chase, Fidelity, Empower, and WEX suggestions do not assert compatibility.
- Link initiation now carries the selected product and provider environment through callback and OAuth resume. Update mode validates saved product/environment before decrypting or sending a token; exchange rejects a changed environment before token exchange.
- Repeated provider callbacks update the existing connection record, preserving its identity and transaction cursor. Initial-sync errors leave the saved connection visible as connected with a needs-sync message.
- Added manual account create/edit/archive/restore, stable independent IDs for same-named records, observed balance date/currency/notes, and include/exclude controls. Provider account sync preserves each account's archive and reporting inclusion settings.
- Added provider account inclusion/archive/restore. Unlink revokes provider access and retains local history; permanent history deletion is a separate confirmed UI action and removes only that connection's accounts, transactions, and holdings.
- Tests cover product selection, mismatched update product, unknown environment blocking before requests, account settings, manual ID behavior, unlink retention, history deletion scope, and connected-but-first-sync state. `npm run check` and `npm run check:local-http` passed in isolated copies under Node 24. The project checkout's generated `dist` was not changed.

**Next:** T09, investment data and manual fallback integration.

## T09 — Investments and manual fallback

**Status:** Implementation complete for balances and holdings. Provider authorization and actual data availability remain owner/provider dependent.

- Investment connections use the investments holdings endpoint and never enter transaction-spending sync. A holdings refresh replaces only that connection's snapshot inside the repository mutation; a provider failure keeps the previous snapshot and marks the connection as needing sync.
- Provider account IDs are now scoped by connection for new records and transaction/holding references. Existing local account IDs are retained during refresh; legacy references are mapped to the existing ID to avoid silently changing local identity.
- Added an Investments view with account balances, provider freshness/errors, holding name/ticker, quantity, value, currency, and valuation date. Holdings are shown as account details and never added again to account-level balances. Unknown and non-USD values are labeled.
- The generic manual account form supports stable-ID investment, retirement, HSA, and other records with institution, observed balance/date, currency, notes, inclusion, edit, and archive controls. Removed the old name-hash investment route that could collide for same-named accounts.
- Checks cover connection-scoped identity, transaction/holding account references, investment endpoint routing, failed snapshot replacement preservation, browser stale status, and available balances. Full finance, SQLite, and isolated HTTP suites pass under Node 24; checkout `dist` remains unchanged.

**Next:** T10, reliable sync jobs, freshness, and local automation.

## T10 — Reliable sync jobs and local automation

**Status:** Implementation complete; the daily timer remains owner managed and is not activated.

- Sync and new-connection requests now return a persisted job record quickly. A second trigger joins the active in-process job; `/api/sync-status` reports progress, completion, partial failure, and safe error messages.
- Every sync result, cursor, account/holding snapshot, and connection error update checks the persisted job ID and running generation. Jobs have a 15-minute bound, each provider request has a 25-second timeout, pagination has a 100-page bound, and safe read endpoints retry network errors, HTTP 429, and 5xx responses with short backoff.
- Completed accounts record last attempt and last successful update. Failed investment refreshes retain the previous snapshot; a failed connection remains connected with an explicit needs-sync state. A persisted running job with no live runner is marked interrupted after process restart.
- The browser polls job status for manual sync, including first sync and reconnect. Settings shows job progress/errors and queries the actual user systemd timer enabled/active/next-run properties. The timer does not get enabled by the app.
- `scripts/sync.mjs` checks for active connections, triggers or joins a scheduled job, polls completion, and exits nonzero on failure/timeout without printing financial data or secrets.
- Tests cover rate-limit retry, concurrent trigger joining, job status and restart recovery, investment endpoint routing, failed snapshot preservation, and timer/job status rendering. Full finance, SQLite, and local HTTP suites passed in isolated copies under Node 24. The project checkout `dist` and live service were not changed.

**Next:** T11, transaction maintenance and safer CSV import/export workflows.

## T11 — Transaction maintenance and imports

**Status:** Core transaction review, pagination, and reversible CSV import workflows are implemented.

- Added stable date/ID ordered server pagination with search, category, account, date range, and review filters. Transactions keeps search, category, account, date, review, month, and page state in the URL and fetches bounded pages. The review queue includes explicit review flags, low-confidence records, and uncategorized/Other rows.
- Added selection up to 100 transactions, revision-checked bulk categorization, persisted before-values, and undo that skips later-edited or missing transactions instead of overwriting newer work.
- Rebuilt CSV import as a preview/commit flow. It maps columns, supports YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY, and positive/negative spending conventions, validates quotes and exact row shape, previews unknown categories for explicit mapping, detects overlap candidates, and requires an explicit choice to retain matching purchases.
- Exact file and account reimports are idempotent. Import batches retain the exact transaction IDs they created; undo removes only those rows. Malformed files fail during preview before any writes. Identical legitimate purchases remain separate.
- CSV export escapes formula-like merchant/category/text values after leading whitespace/control characters without altering stored values; amount fields remain numeric.
- Tests cover parser mappings/sign/date, malformed rows, exact-file repeats, reordered overlap review, explicit preservation of duplicates, batch-scoped undo, paged filters/stable ordering, bulk edit/undo and later-edit protection, and local HTTP import persistence. Full finance, SQLite, and HTTP suites pass in isolated Node 24 copies. Checkout `dist` remains unchanged.

## T12 — Savings goals and funding allocation

**Status:** Implemented, covered, and committed as `T12` milestone source changes.

- Added persistent savings goals, cash allocations, and allocation undo history. The Goals page supports create/edit/archive, priority, target date, planned monthly contribution, explicit dated cash APY assumptions, allocation, and undo.
- Eligible funding is limited to included, unarchived USD depository cash with a fresh successful sync or manual balance date. Available balances cap current balances. Investments, retirement, HSA, credit, restricted, unknown, and stale balances cannot back new allocations; stale cash is shown as provisional.
- The calculation apportions verified backing by goal priority, creation time, and stable ID, caps each allocation, retains allocation records when balances fall, and reports shortages without rewriting history. Goal funds do not alter net worth or spending.
- Required monthly funding uses month-end dates strictly after the as-of date and through the target date, rounded up in cents. The projection defaults to zero return; an optional annual cash APY is explicitly stored with its assumption date and contributions are applied at month end.
- Goal creation, allocation changes, and undo require a matching optimistic revision. Allocation capacity is revalidated against current cash and reservations inside a revision-checked mutation.
- Tests cover restricted/stale/available cash, deterministic priority apportionment, projection boundaries, revision conflicts, over-allocation, undo, CRUD/archive, and Goals page rendering. Full finance, SQLite, and isolated HTTP checks passed in a disposable source copy; checkout `dist` and running service were not changed.

## T13 — Properties and mortgages

**Status:** Implemented in source; automated finance, SQLite, and isolated HTTP checks pass.

- Added manual property and mortgage CRUD with stable IDs, local-only nicknames/optional addresses, ownership shares, valuation source/date, statement balance/date, original principal, origination date, note rate/type, payment components, escrow marker, optional linked liability, and archive controls.
- Observed mortgage balance changes append dated snapshots. Amortization is computed separately and never replaces the statement balance. Duplicate liability links are rejected; equity includes every lien. Partial ownership applies to property value and requires an explicit owner debt share for each mortgage.
- Added a Decimal-based fixed-rate monthly calculator with round-half-up cent payment/interest rounding, capped final payments, zero-rate handling, extra-principal comparison, and non-amortizing payment rejection. Unsupported loan types and incomplete terms are visibly unavailable.
- Home planner shows whole-property and owner equity, statement vs modeled balance as of the statement date, P&I and other payment components, and an accessible yearly principal/interest chart. Property addresses are stored locally and never looked up.
- Tests cover the $320,000 / 6.5% / 360 month payment example, zero-rate and final payment, extra principal, non-amortizing input, multiple liens, negative equity, missing valuation, partial ownership, duplicate linked-liability detection, observed snapshot history, unsupported projections, and page rendering. Full finance, SQLite, and isolated HTTP checks passed in a disposable source copy; checkout `dist` and running service were not changed.
- A later scenario fixture exposed a one-cent rounding residue for some fixed-rate terms. The final modeled period now pays the remaining principal plus interest, preserving the documented final-payment cap.

**Next:** T14, saved home-purchase scenarios.


## T14 — Saved home-purchase scenarios

**Status:** Implemented in source; automated finance, SQLite, and isolated HTTP checks pass.

- Added a versioned, deterministic purchase calculator for down payment, financed fees, fixed note rate/term, escrowed and non-escrowed costs, PMI or explicit no-PMI, closing/prepaids/credits/earnest, moving/repairs, retained reserves, eligible unallocated cash, and optional linked goal funding.
- Results show loan principal/P&I/interest, lender payment, all-in ownership outflow, remaining cash to close, already-paid earnest, all-in funding target, allocated and free cash, shortfall, cash after close, cash-flow fit, and informational DTI. Unknown income leaves the affected output unavailable; rent replacement vs retained housing is explicit.
- Added server previews and save/duplicate/edit/archive/compare flows. Each edit preserves prior quote inputs, rate source/as-of, APR/points/lock information, funding snapshot, result, and calculation version. Goal target updates and Housing budget creation require separate explicit actions.
- Stress views cover rate changes (-1, -0.5, +0.5, +1, +2 percentage points), tax/insurance and maintenance increases, and income reductions. The app makes no lender approval claim and assumes no property appreciation or investment returns.
- Golden tests cover the $400,000 purchase and $88,000 cash-to-close example, $2,022.62 P&I and $3,047.62 ownership outflow, credits/earnest treatment, escrow counted once, reserve/shortfall, missing income, DTI, stress cases, quote version history, explicit goal/budget creation, and UI rendering. Finance, SQLite, and isolated HTTP suites pass from a disposable source copy; checkout `dist` and running service were not changed.

**Next:** T15, balance sheet overview and reports.


## T15 — Overview, net worth, and reports

**Status:** Implemented in source; automated finance, SQLite, and isolated HTTP checks pass.

- Added an Overview balance sheet for cash, investments, other assets, owner property value, debt, assets, and known net worth. Linked mortgage liabilities are counted once; property debt is included with ownership shares; holdings and goals do not add duplicate assets; hypothetical scenarios never enter actual totals.
- Coverage labels call out unknown balances, non-USD exclusions, stale account/property/mortgage values, missing property valuations, incomplete shared-debt allocation, and excluded records. Included and excluded account/property rows are available for drilldown. Manual and stale sources remain identified.
- Added separate goal progress and recorded housing payment components, clearly labeled as plans/commitments outside net worth, plus month-over-month posted spending and effective budget views with refund treatment explained.
- Added an explicit idempotent daily snapshot action. Snapshots are stored locally with totals and coverage; history begins when the owner records a snapshot and does not infer earlier net worth.
- Tests cover cash/investment/property/debt reconciliation, linked mortgage and holdings double-count protection, partial coverage, snapshot idempotency, and Overview rendering. Finance, SQLite, and isolated HTTP suites pass in a disposable source copy; checkout `dist` and running service were not changed.

**Next:** T16, mobile and accessibility polish.


## T16 — Mobile, accessibility, and workflow polish

**Status:** Code changes implemented and isolated UI/finance checks pass. Real viewport and assistive-technology verification remains part of T17.

- Transactions become readable mobile cards at narrow widths; merchant, category, date, and amount remain visible without horizontal scrolling. Table roles/labels remain explicit, and bulk selection has its own touch target.
- Buttons, fields, navigation, pagination, and dialog actions meet a 44 px minimum on mobile. Focus indicators remain visible, category and transaction status updates use live regions, and transaction filters/results are announced.
- Native dialogs receive an accessible heading, Escape reliably closes them, and focus returns to the invoking control. Stable data-attribute focus restoration preserves focus after rerenders. Inline validation remains attached to its form and unsaved scenario previews do not replace the form.
- Weekly spending and mortgage principal/interest charts now expose numeric table alternatives. Category breakdowns already expose names and percentages as text.
- Browser-render assertions and the full finance, SQLite, and isolated HTTP checks pass from a disposable source copy. This ARM64 environment has no installed browser, Playwright, or axe runner, so the requested 320/390 px, 200% zoom, keyboard-only, screen-reader, and slow/offline browser workflows have not been manually verified here; keep them on the T17 release checklist.

**Next:** T17, operational acceptance and release gate. Do not activate production until the browser and operational checks are performed in the owner environment.


## T17 — Operational acceptance and release

**Status:** Source and synthetic acceptance checks are complete; the production release gate remains open pending owner-environment verification. No production activation was performed.

- A synthetic 5,000-row CSV fixture now exercises the maximum supported import size. The finance, storage, SQLite, artifact, and isolated local HTTP checks pass from a disposable source copy. The source boundary check passed for 52 source files, and Gitleaks found no secrets across the 25-commit history scanned. Earlier T02 release work exercised synthetic prepare/activate/rollback and database backup/restore; T10 covers interrupted-job recovery.
- Read-only runtime inspection found the local service active and bound to loopback; the sync timer remains disabled. The root page responds, but `/api/health` and `/health` return 404 on the running service. Private HTTPS authorized/unauthorized identity behavior and Funnel-disabled state have not been fully verified from an owner session. The 404 and unverified identity checks are release blockers; this log contains no private service address or financial data.
- The checkout's `dist` and running service were left unchanged. Builds and checks ran in disposable copies. There is no production rollback location to record because no release was activated.
- Still required before T17 can pass: investigate and resolve the running service health-route mismatch; verify the served code/schema/runtime version and service restart/rollback procedure in the owner environment; verify private HTTPS identity behavior and that public Funnel is disabled without disconnecting the active session; manually run T16's 320/390 px, 200% zoom, keyboard-only, screen-reader, and slow/offline workflows, with automated accessibility checks; and record the chosen release artifact and rollback location after those checks.
- Provider authorization and actual institution coverage remain owner/provider dependent. The daily sync timer stays off unless the owner separately authorizes and verifies live operation.

**Next:** T17 owner-environment release checklist. T18 remains later expansion after the core is trusted.


## C00 — Reconcile baseline and acceptance ledger

**Status:** Baseline reconciled. Source feature work remains in the implementation checkout; no production release or storage migration was performed.

- Current branch is `codex/finance-app-plan` at `08fb5d7` before this entry. The completion plan and the original plan/review documents are local untracked owner documents and remain untouched by staging.
- Read-only service inspection confirms `ledger.service` is active from the checkout through `scripts/dev-server.mjs`, the application listener is loopback-bound, and `ledger-sync.timer` is disabled. The source has `/api/health`; the current checkout's generated `dist` does not. `/health` is not a route defined by source and a 404 there is expected. The live `/api/health` 404 is consistent with its old generated artifact and remains a release verification item; do not rebuild the service checkout in place.
- Implementation acceptance remains open for the C01–C14 tasks in `FINANCE_APP_COMPLETION_PLAN.md`. Earlier T00–T16 notes describe shipped source features, not final production acceptance. The 5,000-row CSV parser assertion does not establish larger database/API/browser performance.
- No private config values, service origin, financial records, or production aggregates were read into the source log. No runtime, timer, data, or generated artifact was changed.

**Next:** C01, correct the savings contribution calendar and deadline labels.


## C01 — Savings contribution calendar

**Status:** Implemented and verified in a disposable source copy.

- Goal projections now include every month-end strictly after the as-of reporting date and on or before the target, including the current month's remaining end. Date-only values remain date-only; instant timestamps are converted to `America/Chicago` before deriving the reporting date.
- Projections return the exact scheduled dates. The Goals page shows the dates and distinguishes a past-due shortfall from a future target that has no month-end contribution before its deadline.
- Optional APY uses the documented annual-to-monthly equivalent with a proportional first-month period, rounds each month-end credit to cents, then applies that date's contribution. Required monthly funding remains the zero-return shortfall divided by the exact schedule, rounded upward.
- Added deterministic cases for October-to-January (four dates), month-end start, early deadline, no remaining contribution date, past-due deadline, leap February, Chicago UTC boundary, APY rounding, and visible schedule rendering. The prior three-date expectation was corrected.
- `npm run check` passed under pinned Node 24.22.1 in a disposable source copy: artifact validation, finance/client checks, JSON storage, HTTP preview checks, and SQLite backup/restore/import checks. The live checkout `dist` and service were not changed.

**Next:** C02, correct cash backing and saved/preview scenario funding parity.


## C02 — Cash backing and scenario funding parity

**Status:** Implemented and verified in a disposable source copy.

- A supplied negative available balance now caps eligible backing at zero. An absent available balance falls back to a valid current balance; malformed supplied values do not increase backing. Liability/mortgage records cannot qualify through a `cash` subtype.
- Scenario preview and save now use the same computed active-goal summary and funding snapshot. Linked-goal backing is sourced from computed backed allocations, not a field missing from the stored goal. Top-level and input-level linked goal IDs resolve consistently; missing/archived goals fail.
- Synthetic API coverage allocates $500 from $1,234.56 eligible cash and confirms preview/save both report $734.56 unallocated plus $500 linked backing, without counting the same cash twice. Domain checks cover negative and missing available values, a cash-typed liability, and an explicitly typed manual cash asset.
- `npm run check` passed under pinned Node 24.22.1 in a disposable source copy. The first run exposed only an existing test assertion that counted an additional archived fixture; it now checks active scenarios. Finance/client, storage, preview HTTP, and SQLite backup/restore/import checks pass. The checkout `dist` and running service were not changed.

**Next:** C03, require explicit scenario costs and preserve historical quote versions.


## C03 — Explicit scenario costs and historical quote review

**Status:** Implemented and verified in a disposable source copy.

- Purchase calculations require an explicit nonnegative amount for monthly housing/acquisition costs; zero is allowed when entered. PMI requires an estimate or explicit no-PMI choice. If net income is supplied, current commitments, planned savings, safety margin, and retained current housing (unless replaced) are required; gross income requires explicit other debt payments. Unknown income keeps the corresponding fit/DTI output unavailable.
- The scenario dialog marks required amounts and says “Enter 0 if none.” Conditional household fields become required when their related income is supplied. Blank down payment stays unknown through preview validation. Financed fees are no longer defaulted from blank to zero.
- Results identify credits/earnest that exceed modeled cash costs. Excess offsets do not create negative cash-to-close or cash-back proceeds.
- Old saved scenarios with missing costs remain readable with an input-review warning. They cannot be compared or used for goal/budget actions. Editing and saving a complete quote preserves its prior missing input in version history; it does not rewrite that history.
- Tests cover missing monthly tax and conditional commitments/debts, explicit zeros, excess credits/earnest, endpoint preview/save rejection, synthetic legacy quote history, guarded goal/budget actions, and incomplete UI warning/action state. `npm run check` passed under pinned Node 24.22.1 in a disposable source copy, including artifact, finance/client, JSON storage, and SQLite checks. The checkout `dist` and running service were not changed.

**Next:** C04, protect local planning/review artifacts from commits.


## C04 — Source/privacy boundary for local review documents

**Status:** Implemented and verified.

- Added exact ignore rules for the local execution plan, review, and completion-plan documents. All three files remain in place in the checkout and are not staged.
- Extended the source boundary check to reject those exact paths even if force-added. Existing database sidecar, export, backup, and secret checks remain unchanged.
- `npm run check:source` passed for the current source index. `git check-ignore` confirms each local document is ignored. In a disposable Git repository, an allowed source/config index passed and a force-added `docs/FINANCE_APP_REVIEW.md` was rejected without printing file contents.
- No owner document was deleted or committed.

**Next:** C05, enforce SQLite schema compatibility and accurate backup identity.


## C05 — SQLite schema compatibility and backup identity

**Status:** Implemented and verified in a disposable source copy.

- The SQLite opener now refuses future versions, missing or noncontiguous migration history, missing or unexpected application tables, and unversioned populated files before changing permissions or journal mode. It applies only pending migrations, with each migration and its version record in one transaction; supported upgrades still require a verified private backup first.
- Backup manifests report the schema version read from the verified backup. A backup API failure now follows the same temporary-file cleanup path as later verification failures. Import emptiness checks include `state_meta` and import ledger rows so metadata-only destinations cannot be overwritten.
- SQLite fixtures verify current schema round trips for encrypted token/cursor pairs, category overrides, budget templates and overrides, goals/allocation history, property and mortgage snapshots, scenario versions/funding, balance snapshots, import undo metadata, sync state, plus integrity, foreign keys, backup, and restore.
- Synthetic tests cover current schema use, v1-to-v2 migration with pre-migration backup, future-schema refusal without journal/content changes, inconsistent histories, unversioned tables, metadata-only import refusal, and atomic rollback after an injected migration interruption. Pinned Node 24.22.1 `scripts/check-sqlite.mjs` passed in a disposable source copy. The checkout `dist`, live service, and production data were not changed.

**Next:** C06, scheduled verified backups, retention, and Settings status.


## C06 — Scheduled verified backups and recovery status

**Status:** Backup implementation and synthetic acceptance are complete. The new systemd timer remains uninstalled and disabled on the live service; install it with the accepted SQLite rollout.

- Added a daily SQLite online-backup runner that validates the active storage mode, uses a dedicated exclusive lock, publishes verified mode-`600` snapshots, and only prunes after the new snapshot succeeds. Retention selects the seven newest daily snapshots plus the newest snapshot from each of the four latest ISO weeks, preserving overlap once and all `pre-migration-*.sqlite` files. Unrecognized filenames are not pruned.
- Restore acquires the same lock as scheduled backup/pruning and refuses to race an active recovery-protection job. Private status records last attempt/success and bounded failure categories without paths or raw errors. Settings reports that status and the actual named systemd timer properties; non-SQLite configuration is shown as not configured. Added an operational recovery checklist that keeps the database paired with its private encryption-key configuration.
- Added dedicated backup service/timer templates and included their scripts/units in release preparation. The backup timer is separate from bank sync. No service, timer, data, generated output, or configuration was changed in the live checkout.
- A controlled synthetic test covered daily/weekly selection and overlap, protected migration copies, private modes, successful restore, failed verification preserving every prior good snapshot, and backup/restore lock contention. In a disposable copy under pinned Node 24.22.1, `npm run check` and `npm run check:local-http` passed, including the new backup test and Settings assertions. The root checkout `dist` remains unchanged.

**Next:** C07, measure realistic 10,000 and 100,000 transaction workloads.


## C07 — Synthetic performance baseline

**Status:** Workload measurements are complete; the documented C08 bottleneck list defines the next implementation scope.

- Added `scripts/measure-performance.mjs`, a manual pinned-runtime benchmark, separate from ordinary timing-sensitive checks. It creates private temporary SQLite datasets with 10k/100k transactions, eight accounts, date/category/merchant variation, refunds, pending/review rows, overrides, goals, property/mortgage, scenarios, snapshots, and budgets. It exercises first/warm bootstrap, selected-month aggregation, filtered 50-row search, single/bulk category edits, a sync-page commit, 5k CSV preview/commit/restart/duplicate detection/undo, and backup/restore; it records response bytes, sample count, median/p95 for sampled reads, peak sampled heap/RSS, and event-loop delay.
- Captured on 2026-10-25 UTC using Node 24.22.1 on Linux ARM64 Cortex-A78AE (6 CPUs, 8 GB RAM). Warm filtered-page p95 was 31.73 ms / 10,625 bytes at 10k and 317.84 ms / 10,735 bytes at 100k, within the stated read targets. Full `/api/state` responses were 2.13 MB and 21.24 MB. At 100k, category writes took 2.26–2.37 s, a sync-page commit 1.47 s, 5k import commit 2.12 s, import undo 1.80 s, and sampled peak RSS was 1.03 GB with 2.59 s event-loop delay p95.
- `docs/PERFORMANCE_BASELINE.md` records fixture shape, method, full timings, caveats, targets, and C08 scope. The benchmark used only synthetic data and removed its temporary databases. No app source runtime, production data, live service, timer, or checkout `dist` was changed.

**Next:** C08, bound bootstrap/page/summary reads and replace measured full-state mutation bottlenecks.


## C08 — Bounded data reads and measured bottlenecks

**Status:** Read and scoped-write slices are implemented and verified; browser acceptance is still open under C10.

- SQLite dashboard responses now omit transaction history, complete scenario/version data, import/category-edit and goal-allocation ledgers, mortgage snapshot history, tokens, and provider cursors. They retain the account/category/budget/goal/property summaries the current views need, cap balance snapshots to the latest 12, and return transaction counts/month choices. Scenario details are fetched when the Home planner opens; Sync status and health read metadata without loading transactions.
- Added bounded month-summary and stable filtered transaction-page APIs. SQLite page queries return at most 100 rows, retain Unicode case-insensitive merchant matching and existing filter semantics, and use date/account/item indexes from schema migration 003. Month summaries preserve complete posted USD totals, refund treatment, purchase counts, weekly chart data, budgets, and six recent transactions. Export walks the same page API only after explicit user action; JSON storage keeps the response contract with its transitional full-state implementation.
- The browser now renders overview charts, budget totals, comparisons, recent rows, month choices, and paged transaction views from the bounded DTOs. It loads scenario history only in the Home planner and exports matching transactions through paginated reads.
- After the read slice, the 100k `/api/state` payload fell from 21.24 MB to 11.3 KB; warm state p95 was 181.98 ms and filtered page p95 was 201.31 ms / 10.7 KB. The same-host interim results and method caveats are recorded in `docs/PERFORMANCE_BASELINE.md`. Read performance targets pass. Whole-state writes remain around 2.6–3.4 seconds on these synthetic workloads, so the task is not complete.
- SQLite now provides serialized, revision-checked subset transactions for single/bulk category edits, import commit/undo, and provider transaction sync. The sync slice commits changed rows, account/item updates, cursor, sync-job progress, and revision in one database transaction after provider calls complete. JSON storage retains the existing conditional whole-state implementation.
- Same-host 100k measurements after the write slice: single category edit 421 ms (2,255 ms C07), bulk category 418 ms (2,366 ms), one sync-page commit with cursor 2.54 ms (1,466 ms), 5k CSV commit 746 ms (2,122 ms), undo 398 ms (1,803 ms). The bounded `/api/state` remained 11.4 KB and warm p95 171 ms; filtered page p95 197 ms. Peak sampled RSS was 426 MB (1.03 GB C07). Measurements are single-sample for writes and not guarantees. Import preview/duplicate matching and POST domain validation still inspect full history; their latency grows with transaction count.
- Pinned Node 24.22.1 `npm run check` and `npm run check:local-http` passed in disposable copies after the final source changes. Coverage includes bounded DTO/API checks, Unicode/page/order/schema checks, selected-row persistence, rollback/revision behavior, cursor-plus-transaction atomicity, import/restart/undo, HTTP guards, and backup recovery. The detailed C07/C08 comparison is in `docs/PERFORMANCE_BASELINE.md`.
- The working checkout `dist`, live service, production state, and timers were not changed. The browser performance/accessibility acceptance remains unverified and is tracked under C10.

**Next:** C09, repair the packaged importer and verify immutable release preparation/activation/rollback with synthetic release state. Keep C10 browser acceptance independent if tooling is available.


## C09 — Immutable release packaging and rollback controls

**Status:** Synthetic package, importer, runtime, backup/restore, health, and rollback checks passed. No release was activated in the live service.

- The legacy importer now resolves its repository module from either the source checkout or packaged `dist/server` tree. Release preparation archives an exact commit, installs locked production dependencies under Node 24.22.1, ships app/sync/backup units, records commit/runtime/schema compatibility, hashes all package files, and publishes a read-only release directory. Existing release IDs are refused before replacement.
- Activation verifies release hashes and identity before switching the current symlink. It restarts the service, checks `/api/health` against the release/schema bounds and verifies the app asset. Failed startup restores prior code only when the current database schema is within that release's compatibility range; otherwise the service is stopped and the database remains in place for explicit recovery.
- `scripts/check-release.mjs` runs from outside the packaged checkout. A candidate prepared from commit `1b7f438` passed import of a synthetic legacy ledger, backup, restore, direct packaged startup, health/build/schema identity, static asset delivery, compatible rollback, and incompatible-downgrade refusal. A duplicate preparation attempt correctly failed without replacing the existing candidate. Release files were mode `444` and the top directory mode `555` after publication.
- `npm run check` passed on a disposable copy after the importer change. Packaging checks reported zero npm audit vulnerabilities; npm emitted a native install-script policy warning, while the packaged ARM64 SQLite binding loaded and passed the migration/import/server checks.
- The temporary candidate was not selected by the production `current` link; no live unit/config/data/timer changed. This is synthetic release evidence, not C11's final gate or C12–C13 production readiness.

**Next:** C10, browser and accessibility acceptance. A pinned ARM64 browser and Playwright/Axe tooling are now installed locally; the automated browser suite is passing. Manual screen-reader and uncovered interaction flows still require owner desktop review.


## C10 — Browser and accessibility acceptance

**Status:** Automated browser acceptance passes in an isolated synthetic environment; required manual checks remain open.

- Added pinned development-only Playwright and Axe dependencies plus `scripts/check-browser.mjs`. The test starts a loopback-only server with a fresh temporary data/config directory, uses synthetic entries only, and removes that state at completion. Chromium 156.0.8078.4 runs locally on ARM64 under the pinned Node 24.22.1 runtime.
- Real DOM coverage exercises empty/manual-only state, all primary views, CSV cancel/preview/commit/undo, filtered search, category bulk edit/undo, CSV export, category create/keyboard rename, zero budget, manual depository account, goal save/allocation and month-end schedule, and explicit-cost scenario save. Automated Axe scans report no serious or critical WCAG 2.0/2.1 A/AA violations in the exercised views/dialogs.
- Layout checks passed at 1440, 390, and 320 CSS px, with a 720 CSS px check representing 200% zoom from a 1440 px viewport. Mobile navigation controls meet 44 px minimum height. The browser suite also verifies keyboard submission for category rename and Escape handling for dialogs.
- `npm run check`, `npm run check:local-http`, and `scripts/check-browser.mjs` passed under Node 24.22.1 in disposable source copies. No root `dist`, live service, production state/configuration, or timer was changed.
- The plan's full manual suite is still pending: screen-reader flows, focus return/visibility and error announcements, category archive and recurring/month overrides, manual investments, mortgage and unsupported projection, scenario preview/compare/actions, backup/sync stale/error recovery, slow/offline/conflict preservation, long-name and chart alternatives, and owner-device private-access review. Orca could not be exercised because this session has no graphical desktop session. Do not treat C10 as fully accepted until these checks have recorded evidence.

**Next:** C11 automated synthetic release/security gate can proceed independently, but final acceptance and C12/C13 remain pending outstanding manual evidence and private migration prerequisites.


## C11 — Final synthetic release and security gate

**Status:** Automated acceptance passed for commit `dacd211bec01`; production migration and activation have not run.

- A fresh shared clone of `dacd211bec01` installed dependencies under Node 24.22.1 with zero reported npm vulnerabilities. `npm run check`, `npm run check:local-http`, and `npm run check:browser` all passed. These include the legacy importer, encrypted token/cursor preservation, interrupted sync recovery, transient/unavailable provider responses, revision conflicts, sync overlap, concurrency, loopback host/origin and proxy-identity guards, and real browser/Axe checks using synthetic state.
- The fresh 10k/100k performance workload passed. At 100k, warm bounded state p95 was 171.04 ms / 11.4 KB, filtered page p95 202.25 ms / 10.7 KB, month aggregation p95 12.94 ms, single/bulk category writes 412/413 ms, sync page 2.45 ms, 5k CSV commit 755 ms and undo 400 ms. Peak sampled RSS was 420 MB. Workload used only synthetic data and removed temporary databases.
- `check:source` passed for the 64-file source index. Gitleaks scanned all 40 commits through this candidate (about 835 KB) and found no leaks. `git diff --check` passed.
- A fresh immutable candidate for `dacd211bec01` was prepared in a temporary release root and passed package checksums, packaged legacy import, backup/restore, startup, health/build/schema identity, static asset delivery, compatible rollback, and incompatible-downgrade refusal. No production release directory or current symlink was changed.
- The local loopback/proxy header tests are synthetic; they do not prove the live HTTPS proxy strips forged identity headers. C10's required owner-device screen-reader and remaining manual browser checks are still open, so this automated gate does not authorize C12/C13 activation.

**Next:** C10 manual acceptance remains an owner desktop dependency. After it is recorded, resume C12 with the private storage/key reconciliation and recovery checks; activate only after that operational gate passes.


## R01 — Fail-safe backup retention

**Status:** Implemented and verified in a disposable source copy.

- Scheduled retention and backup selection now share one strict generated-daily filename parser. It rejects malformed and impossible dates, so pruning only considers valid timestamped backups outside the seven-daily/four-weekly keep set.
- Synthetic scheduled-backup acceptance confirms `daily-owner-copy.sqlite`, an archive file, and a malformed timestamped name survive byte-for-byte; an old recognized daily backup is pruned. Existing pre-migration protection, retention counts, failed-backup preservation, private modes, and backup/restore lock contention still pass.
- Pinned Node 24.22.1 `scripts/check-backup.mjs` passed in a disposable source copy. No owner backup directory, live service, preview records, timer, or root `dist` was touched.

**Next:** R02, correct net-worth classification for liabilities with conflicting asset subtypes.
