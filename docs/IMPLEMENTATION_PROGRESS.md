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
