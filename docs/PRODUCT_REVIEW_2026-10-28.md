# Finance application product and engineering review

Reviewed the current dirty working tree based on `6d5fc0cfadf6e82c0bc65ef78329e8c9a51f0834`. This assesses the source candidate, not the deployed service. No live financial records, bank connections, or private configuration were accessed. The owner-specific implementation progress document was excluded.

## Assessment

Ledger has a credible engineering foundation for a private personal finance application. SQLite transactions, integer-cent calculations, revision checks, sample isolation, restricted network access, and recovery rehearsals are substantial strengths. However, the product still has core budgeting workflow defects and gaps in recovery from uncertain saves. It is useful as a supervised tracker, but should not yet be treated as the sole authority for spending decisions or as a fully reliable unattended financial system.

The biggest gap is between storing numbers correctly and helping the owner establish that those numbers are complete, current, and reconciled. Additional charts and planning features should follow repairs to that foundation.

## Confirmed findings

### P1 — Budget setup hides categories before the user can plan them

Evidence: `ui/browser.js:76` filters budget rows to those with a non-null plan, actual spending, or activity. The category manager at line 71 only offers rename/order/archive controls. The new-category endpoint rejects existing category names.

Fresh Chromium reproduction against an empty synthetic SQLite database:

- The budget page had zero budget editors, including zero Housing editors.
- Creating a custom bucket with its explicitly optional amount left one category-management row and zero budget editors.
- Trying to create Housing through the API returned 409 because it already exists.

Impact: a new user cannot plan an unused built-in category through the normal budget controls. A custom bucket created without an amount also cannot be given its initial plan through that table until activity exists.

Fix: provide an “Add category to this month's plan” action for existing categories, keep unplanned buckets discoverable, and let every category open a budget editor. Acceptance must start with a genuinely empty account rather than a seeded demo.

### P1 — New buckets ignore the month being viewed

Evidence: `ui/browser.js:175` omits a selected/effective month from category creation. `worker/budget-routes.mjs:105` creates the template using the current reporting month.

Fresh Chromium reproduction: while viewing September 2026, creating a $100 bucket produced a 10,000-cent template effective October 2026. The September budget still showed no editor for it.

Impact: the success message refers to a plan saved outside the visible month. This makes historical planning confusing and can silently apply a commitment to the wrong period.

Fix: show and submit an explicit effective month, initialized from the selected month. Explain whether the action changes this month only or future months too.

### P1 — Save deduplication does not survive a browser reload

Evidence: `ui/requests.mjs:8` keeps operation identities only in an in-memory Map. `worker/index.js:587` allows distinct manual account creates with the same details when they have different operation identities.

Fresh synthetic reproduction: the server committed a manual account while both responses to the client were deliberately lost. A new client instance, representing a reloaded browser, resubmitted the same details using the refreshed revision. The database contained two accounts.

This does not mean reloading alone creates duplicates. It means repeating an uncertain create after reload loses the prior operation identity and is treated as a new action. The existing server-restart tests exercise a different failure boundary.

Fix: provide a recoverable pending-save identity and a server operation-status lookup, with a visible “Checking whether this saved” state. Persist only minimal recovery metadata in the browser under an explicit privacy contract; avoid caching financial form contents by default. Do not deduplicate legitimate separate accounts solely by matching names.

### P1 — Archiving can change historical Overview budgets and disagree with Budgets

Source-confirmed: `ui/browser.js:21`, `:34`, and `:64` build Overview budgets and month comparisons from currently active categories. The budget table at line 76 retains archived categories when they have a plan or activity. Archiving in `worker/budget-routes.mjs:131` changes category metadata without ending its recurring plan.

Impact: an archived category's historical budget disappears from Overview's totals while remaining in the budget page. Current archive status influences past-month comparisons. Continuing recurring allocations after archival is also ambiguous.

Fix: resolve both screens from the same month-specific budget model. Preserve historical categories and make “stop future funding” an explicit effective-dated action separate from hiding a category from new transaction assignments. Also fix line 64's zero-total display, which currently says “No set limit” for a deliberately zero budget.

### P2 — SQLite category persistence diverges from the category-limit check

Evidence: category creation appends to both `categoryRecords` and `customCategories` and enforces its 50-category cap using `customCategories.length` (`worker/budget-routes.mjs:100`). The scoped budget writer (`server/sqlite-repository.mjs:270`) discards `customCategories` from metadata without updating its SQL table.

Fresh SQLite reproduction: 51 successful category creates left 51 category records and zero legacy custom-category entries. The declared limit was bypassed. Categories remain visible through `categoryRecords`; this is not a claim that those 51 categories were lost.

Fix: select one authoritative category representation, migrate the legacy representation deliberately, and enforce limits against persisted canonical records. Add parity coverage for category creation and reload, not just transaction-table write isolation.

### P2 — The replay log retains complete request payloads indefinitely

Source-confirmed: `worker/index.js:81` calls a serialized request a fingerprint; it is not a cryptographic digest. Lines 100–106 append it and the response to `operationResults`. SQLite stores this array in the shared `state_meta` JSON, which is parsed and rewritten by many otherwise scoped operations.

Impact: import replay entries retain CSV request content; other entries retain submitted financial details. Storage and per-write work grow with accumulated saves, independently of transaction-query indexes. This is also a data-retention decision that the product does not explain.

Fix: store a canonical payload digest and minimal replay response in an indexed operations table. Define retry/recovery retention and preserve appropriate tombstones so cleanup cannot accidentally make an old retry create a duplicate. Benchmark years of operations and repeated imports, not only large transaction counts.

## Budget storage and financial meaning

Keep SQLite. WAL, FULL synchronous writes, atomic transactions, revision checks, pre-migration backups, stable category IDs, and effective-dated amounts are appropriate foundations. Moving to another database would not fix the product defects above.

Consolidate the budget model. Template and override amounts currently live in SQL tables while frequency, original period amount, due month, category settings, and history boundaries live in metadata JSON. Store a complete versioned budget record with validation tying source amount and frequency to monthly cents, plus the effective date and scope. This is a maintainability and integrity improvement; split storage alone does not demonstrate an atomicity failure because current writes are transactional.

Budget edits overwrite the entry for an existing category/effective month. Effective dating is not a complete edit audit trail. Add before/after history, a clear undo/revert workflow, and optionally a month-close snapshot so later corrections have an explanation.

A carried budget balance is a planning allowance. It is not evidence that corresponding money exists in a bank account. Likewise, expected surplus uses budget defaults and expected income, not a dated cash-flow schedule. `shared/budgets.mjs:113` assumes zero further spending for an unplanned bucket unless adjusted; completeness is only marked false when that bucket has activity. An empty expense plan with projected income can therefore look complete despite omitted commitments.

Improve the product with an explicit completeness checklist, visible forecast assumptions, an opening/carryover/allocated/spent breakdown, and click-throughs to the transactions and historical edits that produced a balance. Preserve the established weekly-times-four convention and explain it in the editor.

## Security and operational reliability

The source contains useful protections: loopback binding, Host checks, Tailscale owner checks for proxied access, cross-site request checks, same-origin POST validation, a restrictive CSP, escaped UI output, CSV formula escaping, encrypted provider tokens, private file permissions, and bounded diagnostics. A fresh `npm audit --json` returned zero known advisories. That result is dependency evidence, not a penetration-test certificate.

The local loopback interface deliberately grants local-owner access. It is a trusted-host design, not a separate application login boundary. A local process or user able to access that endpoint is inside the trust boundary. Document this assumption and use OS account isolation or stronger local application authentication if it does not fit the deployment.

Financial database contents are not encrypted by the application. Recovery bundles contain both the database and a readable configuration/key snapshot protected by filesystem permissions. These permissions protect against other ordinary OS accounts; they do not establish protection against device theft, privileged access, or theft of a copied bundle. Disk encryption status was not inspected.

Backups are created under the same data directory as the database (`scripts/backup-runner.mjs:38`). This supports recovery from logical mistakes, but same-device backups do not cover loss of the device or its storage. Add encrypted copies in a separate failure domain and rehearse restoration onto an empty replacement environment. Agree on an acceptable data-loss window and restoration time, and expose whether those targets are being met.

The “complete” recovery status verifies bundle structure, checksums, and a configuration-key fingerprint. `scripts/recovery-bundle.mjs` does not prove that actual stored tokens decrypt using that configuration. The synthetic token recovery checks are valuable, but the production status should distinguish bundle verification from a successful restore/decryption rehearsal.

Backup health and detailed sync state are mostly in Settings. Promote actionable failure and stale-data information near balances and forecasts. Provide recovery instructions that can be followed without remembering shell commands.

## Product-owner priorities

The next release should focus on a complete monthly workflow: connect/import, establish opening balances, plan before spending, review uncertain transactions, reconcile against statements, explain discrepancies, close the month, and recover from mistakes.

1. Repair the P1 budgeting and uncertain-save paths above. Test empty-account onboarding and browser reloads as first-class journeys.
2. Add statement reconciliation with an explicit discrepancy and reviewed-through date. The existing provider-sync reconciliation code is not a user-facing statement reconciliation workflow.
3. Make every important total explainable: included accounts, posted/pending treatment, reporting currency, source date, and drill-down. Separate money available today from projected monthly surplus.
4. Improve budget editing with a concise read view, an explicit editor, predictable ordering, selected-month creation, and change history. Current move controls update category order, while budget rows sort by group/name; clarify which order users are changing.
5. Add practical transaction tools as needed: split a purchase across categories, distinguish reimbursements/refunds, and review recurring commitments. Add a full portable export for plans, category identities, account observations, goals, and history; the current CSV export is a transaction report, not a complete application export.
6. Prove unattended operation with visible freshness, separate-device recovery, and a documented restore exercise before treating the tool as the owner's sole finance system.

## Verification scope

Fresh checks in this review: synthetic SQLite API probes for category persistence and uncertain-create recovery; Chromium journeys for empty budget onboarding, optional-amount bucket creation, and selected-month creation; dependency audit. All temporary servers and synthetic databases used by those probes were stopped and removed.

The earlier integrated, browser, accessibility-tree, and release-rehearsal passes remain useful prior evidence. They were not rerun wholesale for this review. The new probes expose scenarios outside that earlier coverage.

No live bank reconciliation, current deployment audit, actual screen-reader assessment, physical 200% zoom assessment, device encryption check, or full repository privacy review was performed. Source-confirmed findings are identified separately from reproduced behavior. This review changes documentation only.
