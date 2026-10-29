# Product implementation execution

Working against base `6d5fc0cfadf6e82c0bc65ef78329e8c9a51f0834` in the existing dirty tree. Synthetic fixtures only; no live accounts, configuration, bank requests, service changes, or original-checkout staging/commits.

## Increment A — usable, consistent budgeting

### P00 — PASS

Added isolated browser cases `budget-empty-onboarding`, `budget-create-month`, and `budget-archive-history`. Added a SQLite regression that seeds 50 canonical custom categories with an empty legacy list and verifies that category 51 is rejected. The test proves the prior cap bypass and guards the repair.

### P01 — PASS

Budget rows now include unused active expense/allocation categories; archived rows remain visible when they have a plan/activity. A bucket created with a blank optional amount appears in the editor and can receive a plan before transactions exist. The plan row's live error is nested in a table cell so Axe's required row-child rule remains satisfied.

### P02 — PASS

New-bucket dialog now carries the selected effective month and an explicit recurring/month-only scope. The API validates both and stores a recurring template or month override with the source schedule. Sample mode mirrors the selected scope locally. The UI reports the saved month/scope.

### P03 — PASS for category cap and compatibility projection

Category creation now counts canonical custom category records, including archived records, rather than relying on the legacy string list. New writes use `categoryRecords` as authority. SQLite scoped budget writes now synchronize the legacy custom-category name projection from canonical records while retaining legacy names. Tests verify category 51 rejection and projection persistence.

### P04 — PASS

Overview budget totals now include archived categories' effective plans, matching the Budgets history view. Month comparisons use each month's own effective plans, including archived categories. A known zero plan displays `$0.00` rather than “No set limit.” The browser regression archives a planned bucket and confirms the Overview balance and Budgets row remain consistent.

## Verification for Increment A

- `npm run check` — PASS: build, artifact validation, finance, budget, local storage, SQLite, backup/recovery, and runtime checks.
- `npm run check:local-http` — PASS: local server guards, persistence, restart, and shutdown.
- `npm run check:browser` — PASS after the table-row accessibility adjustment; zero serious/critical Axe violations in covered views.
- `BROWSER_CASE=budget-empty-onboarding npm run check:browser:case` — PASS.
- `BROWSER_CASE=budget-create-month npm run check:browser:case` — PASS for recurring and month-only scope, selected effective month, and exact cents.
- `BROWSER_CASE=budget-archive-history npm run check:browser:case` — PASS.
- `npm run check:sqlite` — PASS, including the canonical category cap and compatibility projection cases.
- `git diff --check` on implementation files — PASS.

## Increment B — trustworthy storage and recovery

### P05a — PASS

`shared/operation-identity.mjs` defines canonical JSON and scoped SHA-256 operation identity. The digest includes every request field except `clientOperationId`, including the original expected revision. This lets exact retries replay while changed values conflict. Arrays retain order; non-JSON inputs are rejected.

### P05b — PASS

Schema version 5 adds `operation_results`, keyed by operation ID. Replay lookup uses the primary-key index. SQLite commits the domain mutation and its minimal `{scope, digest, response, revision, timestamp}` record in one transaction. Existing scoped budget, owner, and transaction writes remain scoped. The JSON adapter stores the same minimal record in its state commit. Replay records are durable and have no automatic expiry.

### P05c — PASS

Version 1–4 databases migrate old raw fingerprints transactionally and repeat-safely; old result IDs and responses remain readable, and raw fingerprints are removed only after insertion succeeds. The migration has a verified pre-migration backup. SQLite checks cover replay, payload conflict, migration/reopen, index use, and an injected operation-row failure that proves the domain edit rolls back too. JSON parity is covered. Replay digests include no CSV content.

Storage sample (`bash scripts/run-node.sh scripts/measure-operation-storage.mjs`, Node 24.22.1; one synthetic SQLite run):

| Replay rows | Insert time | 1,000 indexed lookups | State metadata bytes |
| ---: | ---: | ---: | ---: |
| 10,000 | 69.3 ms | 10.1 ms | 91 |
| 100,000 | 720.3 ms | 12.6 ms | 91 |

Fifty real synthetic CSV imports inserted 50 rows in 302.7 ms with 100,050 replay rows already present. The separate import batch metadata grew to 15,760 bytes because it records imported batches; replay payload history did not enter metadata, and raw CSV/merchant markers were absent from operation records. These are measurements, not performance guarantees.

Verification: `npm run check` — PASS; `bash scripts/run-node.sh scripts/check-sqlite.mjs` — PASS; benchmark — PASS.

### P06a — PASS

Added authenticated, read-only `GET /api/operation-status?operationId=…`. It enforces the current owner boundary and returns either the exact committed result or `unknown`; responses inherit `no-store`. Unknown does not mean failed.

### P06b — PASS

Replay-safe writes persist only operation ID, path scope, original base revision, and start time in same-tab `sessionStorage`. Reload checks status before the normal refresh. Confirmed writes clear metadata; unknown/error states remain visible and are never retried automatically. Re-entry reuses the original ID and revision; changed payloads conflict. Clearing an unresolved reference requires explicit confirmation. Storage failure produces a visible limitation. Sample mode does not write recovery state.

### P06c — PASS for the implemented recovery matrix

The browser case `operation-reload-recovery` commits a manual account, drops the first response and same-ID retry response, restarts the local server, reloads the actual page, confirms one saved account, and verifies session storage contains no account name, institution, balance, or form data. It also verifies that an unknown lookup does not issue a new write and remains until explicit user resolution. Existing `operation-restart` covers replay of category, goal, property, mortgage, scenario, CSV, and budget writes across a server restart.

Verification: `bash scripts/run-node.sh scripts/check-finance.mjs` — PASS; `BROWSER_CASE=operation-reload-recovery npm run check:browser:case` — PASS; `npm run check:browser:harness` — PASS.

### P07a — PASS

Added `shared/budget-records.mjs` as the complete value model. Every record has stable category ID, effective month, recurring/month-only scope, monthly cents, source cents, frequency, and due month. Model validation enforces the supported frequency/date rules and derives monthly cents from source cents; unknown/null and known zero remain distinct. Legacy projections can be generated from the canonical records.

### P07b — PASS

Schema version 6 adds `budget_records`. Migration copies existing templates, month overrides, and schedule metadata together, preserves zeros and exact weekly/annual/semiannual source amounts, and removes old schedule JSON only in the same transaction that inserts the complete records. A version-3 fixture migrates and reopens with an annual plan and a zero override intact. Invalid or ambiguous records fail the migration; the existing automatic verified pre-migration backup remains in force.

### P07c — PASS with compatibility projections retained

SQLite now hydrates budget template/override and schedule compatibility views from `budget_records`; writes validate and persist the complete records in the same transaction. Existing UI and API projections remain because current consumers still use them. The source record table is canonical, and the projections are retained until those consumers move.

Verification: `npm run check` — PASS at schema version 6; focused `check-sqlite` and `check-finance` — PASS. Existing budget-frequency, zero/null, reset, rollover, and month-scope checks remain green.

### P08 — PASS

Added append-only `budget_change_history` storage and owner-authenticated history/revert/stop-future routes. Budget, income, outlook, reset, category, and stop-future mutations record before/after snapshots atomically with operation results. Reverts create new revisions and reject stale current values. Stop-future preview lists later templates/overrides; applying creates known-zero future allocations while preserving earlier carryover. Browser controls support preview, cancel, apply, and history/revert. JSON and SQLite checks cover audit idempotency, stale revert, future overrides, and preserved carryover.

Verification: `npm run check:budget`, `npm run check:sqlite`, and `BROWSER_CASE=budget-history-controls npm run check:browser:case` — PASS.

### P09 — PASS with explicit limits

The shared budget projection now reports expense-plan coverage and unplanned activity separately; an income-only projection is not marked structurally complete. The budget page explains allowance arithmetic, links the month’s transactions and prior month, distinguishes account balance observations from allowance, labels the month-end number as an estimate, identifies remaining plans/recorded activity limitations, and explains weekly × 4. Unknown income remains distinct from known zero. This is not a claim of complete financial obligations; there is no user-reviewed commitment acknowledgement yet.

Verification: `npm run check:budget` and `BROWSER_CASE=budget-empty-onboarding npm run check:browser:case` — PASS. Synthetic cases cover income-only, unknown/zero income, net-zero activity, and carryover arithmetic.

### P10 — PASS for initial USD statement review workflow

Added `shared/statement-reconciliation.mjs` with signed balance math for USD depository and credit accounts. The account dialog captures opening/closing statement observations and an explicit transaction-coverage confirmation. The authenticated API stores immutable review snapshots, includes posted transfers and refunds, excludes pending transactions, preserves discrepancy without changing ledger data, and flags a review when transaction facts inside its period change. Investments and unsupported currencies are not reconciled. Incomplete coverage may be saved only as an explicitly incomplete review. Account sync time alone does not establish reconciliation.

Review fingerprints include only transaction IDs, dates, signed amounts, currencies, and pending status for the reviewed account/window. Out-of-window transaction edits do not invalidate the review. Statement snapshots are append-only in repository state metadata and are included in existing state/backup serialization.

Verification: `npm run check:statement-reconciliation`, `npm run check:budget`, build, and `node --check dist/server/index.js` — PASS. Fixtures verify the $1,000 + $500 − $200 − $100 = $1,200 depository case, the $300 + $50 − $100 − $20 = $230 credit case, pending exclusion, incomplete coverage, and in-window invalidation.

### P11 — PASS

Budget rows now open in a concise read view. The accessible Edit plan action reveals source amount, frequency, due month, scope, save/reset/stop controls, and errors; failures retain the draft and restore focus. The planned monthly equivalent and source-period amount are both shown. Category order is persisted within groups and is reflected in the displayed row order.

Verification: full browser acceptance covered keyboard editing, conflict/offline draft retention, long names, archived rows, and 1440/390/320 CSS-pixel layouts. It also exercised a 720 CSS-pixel viewport corresponding to a 200% browser zoom setting; this does not substitute for physical browser zoom or human screen-reader testing.

### P12 — PASS

Recovery status now reports checksums, SQLite integrity, local decryption of stored token blobs (or explicitly no tokens), and restore rehearsal as separate results. Backup age and a latest failed attempt remain visible; an unverified, stale, or failed bundle produces an accurate warning. Documentation states that SQLite financial data is not encrypted at rest and that recovery bundles contain the key needed to decrypt provider tokens.

Verification: full `npm run check` passed the synthetic wrong/missing-key, corrupt database, no-token, permissions, interrupted backup, and runtime status checks. No live owner data or service was accessed.

### P13 — IMPLEMENTED; ENCRYPTION ROUND-TRIP NOT_RUN

Added operator-only `age` recipient encryption and fresh-directory restore-rehearsal CLI commands. The stream now carries tar output into age, then writes age ciphertext atomically; restore status uses the recovery verifier’s returned token result and marks the completed rehearsal check as passed. Commands verify the recovery source, require a private destination/identity, refuse overwrite, clean temporary files after failure, and never expose filesystem controls in the browser. Documentation records operator configuration requirements.

Verification: `npm run check:encrypted-backup` passed fail-closed configuration checks. The `age` executable is unavailable in this environment, and the plan forbids installing tools; ciphertext marker, correct/wrong key, and encrypted restore round-trip cases are therefore **NOT_RUN**. No destination, key, timer, or deployment was configured.

### P14 — PASS for synthetic snapshot export and validation

Added a versioned portable export with one SQLite read transaction, stable IDs and relationships, exact cents, record/byte bounds, and omission of tokens, credentials, and raw replay payloads. The synthetic validator checks references and rejects unsupported versions; no production importer UI was added.

Verification: `npm run check:portable-export` passed snapshot consistency, ID/reference/cents validation, secret sentinels, bounds, and no-overwrite checks.

### P15 — PASS for available candidate gates; see explicit NOT_RUN gates

The disposable candidate was copied from the dirty source tree without the protected progress and stability-review documents, `.git`, `dist`, or `node_modules`; dependencies were installed with the pinned Node 24.22.1 runtime. Candidate commands passed: `npm ci`, `npm run check`, `npm run check:local-http`, `npm run check:browser`, and `npm run check:browser:harness`. `npm audit --json` reported zero vulnerabilities.

Focused browser cases passed: `budget-empty-onboarding`, `budget-create-month`, `budget-archive-history`, `budget-history-controls`, `budget-frequency-history`, `budget-two-tab`, `operation-restart`, `operation-reload-recovery`, `sample-isolation`, `accessibility-tree`, and `transaction-splits-commitments`. The full browser suite passed 1440/390/320 CSS-pixel layout checks, keyboard flows, import preview/commit/undo, a UI-level statement review with a synthetic zero discrepancy, and zero serious/critical Axe violations in covered views. The HTTP gate passed owner/Host/Origin guards, persistence, locking, and restart checks. Candidate source schema is SQLite version 7 (migrations 001–007).

A Gitleaks scan covered 62 authorized changed/untracked files copied to a temporary scan directory; the two protected documents, generated dependencies, build output, and Git metadata were excluded. It surfaced one reviewed false positive: the literal `PENDING_OPERATIONS_KEY` storage-key constant in `ui/requests.mjs`, not a credential. No other finding was reported. No files were staged to expand scanning. Physical zoom, screen-reader use, age encryption round-trip, off-device backup, and owner-data restore remain NOT_RUN.

### P16 — PASS for implemented split and reimbursement review

Added an exact-cent signed allocation model that keeps parent transaction facts authoritative. Reports count allocations or the unsplit parent, never both; account reconciliation continues to count the parent once. Split edits are replay-safe and audited, undo restores the unsplit view, provider corrections mark splits for review, and reimbursements have a cross-month searchable picker, live review status, and an explicit audited remove action. The API checks for a negative USD reimbursement, positive USD purchase, bounded amount across all active links, and duplicate links.

Verification: `npm run check:transaction-splits`, SQLite report checks, and the focused `transaction-splits-commitments` browser case passed synthetic sign, exact-cent, pending replacement, correction review, reimbursement API/UI, persistence, and undo coverage.

### P17 — PASS for implemented commitments and dated forecast

Added explicit user-entered recurring commitments with weekly/monthly/annual calendars, month-end clamping, effective-date cancellation that preserves past occurrences, a selectable historical month whose match status comes from the server, and dated occurrences. Payment matching requires an explicit confirmation, a positive USD payment, and selected due date; a transaction or occurrence can only be matched once. Missing, changed, or duplicate stored matches return to review. Matching does not reclassify or alter the observed transaction. Monthly budget conventions remain separate from actual scheduled dates.

Verification: `npm run check:commitments` and the focused `transaction-splits-commitments` browser case passed five-week-month, annual/leap-date, end-of-month, historical cancellation dates, positive USD matching, duplicate prevention, and transaction-neutrality checks. No automated obligation detection or “safe to spend” claim was introduced.

## Remaining external gates

This log records candidate code and synthetic acceptance only. The `age` encryption/decryption round-trip remains NOT_RUN because the executable is absent and installing it is outside the authorized plan. An owner-selected off-device destination, acceptable data-loss window, restore-time target, device encryption, deployed release activation, live bank reconciliation, physical zoom, screen-reader use, and full privacy review remain NOT_RUN. Do not infer live-service reliability or whole-system trust from these code checks.

## Remaining external gates

This log records code work only. It does not establish live bank reconciliation, deployment status, owner-data recovery, physical 200% zoom, screen-reader use, device encryption, or a full privacy review.
