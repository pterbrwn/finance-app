# Ledger: independent validation and household-quality plan

Review date: 2026-11-08. Reviewed source: `4143cf8ea38659f96249dd69e0b0c5e044eee18e`, initially clean on `main`.

## Verdict

The earlier review's direction is reasonable, but its numeric scores and claim that the remaining blocker is mostly outside the code are not supported. Current-source probes expose financial classification and review defects. Ledger has substantial functionality and recovery engineering; it is not yet a fully dependable, effortless tool for both household members.

Treat 10/10 as completion of the household outcomes below, not a promised absence of every possible bug. Maddie's Tailscale configuration belongs to Peter and is excluded from this implementation backlog and app-quality rating.

## Evidence and boundaries

- Read current financial automation, reporting, API, UI, dialogs, recovery checks, test runner, and release documentation.
- Ran independent synthetic automation probes against the checked-out shared modules.
- Ran Chromium against a disposable SQLite server; injected a synthetic backup status response, inspected current Settings and mobile Transactions, and viewed fresh screenshots.
- Fresh test results are recorded below. Tests ran in a disposable shared clone, using pinned Node 24.22.1 and the existing dependency installation. This is not a fresh dependency-install or advisory audit.
- No production database/configuration, bank credentials, provider calls, service activation, or timer changes were part of the review. Actual deployed identity, actual backup configuration, and actual bank scheduler state are not established here.
- Synthetic browser startup reads host timer status through the existing runtime adapter. Such displayed timer values do not establish bank connectivity or a production readiness verdict.
- Mechanical design detector: one Inter-font advisory. It is not a usability failure and changing the font is not a priority. No new numerical design/technical score is assigned from this limited rendered sample.

### Corrections to the earlier review

1. `README.md` contains conflicting production-code references (`bc2cf41a77b4` and `45eba0047502`), while source HEAD is newer. The previous answer presented a documented deployment as independently verified; it was not.
2. October critique scores describe earlier source. They cannot be used as a current 6–7/10 design rating. Current source includes the filter-disclosure persistence, active-count, scenario requirements, and layout work.
3. Current mobile sample Transactions starts its first row at **556.39 CSS px** at 390×844, consistent with the recorded improvement. Add-transaction discoverability still fails independently of that placement metric.
4. `npm run check` now invokes all five CI profiles. Earlier notes describing it as a narrower suite are stale.
5. Live bank sync is optional. A well-supported manual/CSV workflow can meet household needs without enabling it. If chosen, real bank acceptance remains necessary.
6. Screen-reader/physical-zoom testing is valuable acceptance evidence, not a reason by itself to declare the app unusable for these two people. The fresh financial and workflow defects below are more immediate priorities.
7. The elapsed development history cited in the previous answer was overstated: October 25 to November 8 is roughly two weeks, not a month.
8. Encrypted recovery is no longer unverified at the code level: today's real age round-trip passed. This does not establish that an off-device backup destination is configured in production.

### Fresh verification results

| Check | Result |
| --- | --- |
| Fast profile | PASS: finance, budgets, statement reconciliation, splits, bills, manual transactions, artifacts |
| Integration profile | PASS: HTTP guards/persistence, SQLite, paired backup, runtime parsing, portable export |
| Recovery profile | PASS: paired recovery plus real tar/age encryption/decryption, wrong key, corrupt ciphertext |
| Browser profile | PASS: broad acceptance, harness self-check, all 23 focused cases |
| Release profile | PASS on corrected test-checkout setup: source boundary, source-scan harness, immutable release rehearsal |
| Independent automation probes | Reproduced F1–F3 and rule-order mismatch in F8 |
| Independent Chromium probes | Reproduced F4/F6; no review-action controls; inspected current screenshots |
| Fresh 390px sample Transactions and Budgets Axe A/AA checks | Zero violations in these two rendered states |
| Original-worktree diff whitespace check | PASS; only this new review document added |

The first `npm run test:ci` invocation exited 1 at the release profile because my disposable checkout used a `node_modules` symlink. The source-boundary guard correctly rejected the unignored symlink. Replacing it with a copied dependency directory and rerunning only `test:release` passed. No application change or relaxed test assertion was needed. The other four profiles passed in the original run. The candidate source fingerprint remained unchanged during each profile.

Evidence files are local cache artifacts: `~/.cache/ledger-astra-review-ci.log`, `~/.cache/ledger-astra-review-release.log`, and final browser screenshots under `~/.cache/astra-synthetic-vvuwaB/`. The independent browser probe is `~/.cache/ledger-astra-browser.mjs`. Initial probe attempts hit a hidden-button wait and an Axe context-creation requirement; the corrected probe completed. Neither was treated as a production runtime crash.

Broad browser output calls its 720 CSS-pixel check “200% zoom”; it remains a viewport proxy, not newly performed physical zoom. No live bank, off-device owner restore, physical-device, or human assistive-technology acceptance was run here.

## Independently established findings

P1 = materially misleading financial/status behavior; P2 = significant usability or maintainability gap. These priorities are review-specific, not claims of production incidents.

### F1 — P1: broad default rules can hide expenses and bypass review

**Locations:** `shared/rules.mjs:73–101,146–158,203–242`; `shared/reporting.mjs:69–79`.

A synthetic USD $25 transaction named `Fidelity service fee`, initially Other, becomes Transfers under the shipped merchant-substring default. Spending changes from 2,500 cents to zero. `review` becomes false because every rule-applied transaction bypasses review. The synthetic account was owned by Maddie: system-category defaults are not person-specific.

There are also household-specific assumptions embedded in shipped defaults. Do not copy their literal names/amounts into new fixtures or documents. Their provenance and suitability for both people require review; do not assume they are synthetic or appropriate globally.

**Required outcome:** explicit scope and explainable rule provenance; conservative transfer defaults; no blanket exemption from review solely because a rule ran. Preserve intentional user-approved rules and manual edits. Preview corrections to existing history rather than rewriting it silently.

### F2 — P1: provider low confidence does not enter the review queue

**Locations:** `shared/reporting.mjs:40–66`; `shared/rules.mjs:146–158`.

`fromPlaid` stores a string confidence at `personalFinanceCategory.confidence`. `reviewReasonFor` checks numeric `transaction.confidence < 0.5`. A synthetic Plaid restaurant transaction with confidence `LOW` produced `review:false`.

**Required outcome:** one explicit confidence contract for provider and imported records; low/unknown states handled deliberately; manual confirmation remains distinguishable from automated classification. Verify fresh sync, provider corrections, persistence, and filtered review results.

### F3 — P1: transfer-counterpart matching accepts different currencies

**Locations:** `shared/rules.mjs:109–129,166–194`.

A +5,000-cent USD transfer and a -5,000-cent CAD transaction in a different account on the same date result in `hasCounterLeg:true`, `review:false`. Raw cents are not equivalent across currencies. The matching predicate also lacks a one-to-one pairing model; that is a follow-up case to test, not a newly reproduced duplicate-pair finding.

**Required outcome:** compatible currency, explicit account/date/sign rules, and unambiguous pairing. Ambiguous candidates remain reviewable. Re-evaluate affected records when counterpart facts change.

### F4 — P1: Settings' reassuring summary contradicts recovery evidence

**Location:** `ui/browser.js:263` (`settingsPage`).

Fresh Chromium with synthetic status `{state:'success', recoveryState:'incomplete', recoveryStale:false}` and unknown verification fields shows **Everything looks fine / Last saved recently**. Expanded details correctly show **Database backup only; recovery pair unavailable**. There is no success timestamp in the fixture. The screenshot also shows the top-level missing-recovery warning, making the contradiction explicit.

The summary's `healthy` predicate checks only success and staleness, unlike the more demanding detail predicate. Bank updates On/Off similarly reduces scheduler state without establishing successful data retrieval.

**Required outcome:** one shared status model for summary, banner, and details; distinguish verified/current, stale, failed, incomplete, never run, and unknown. Do not fabricate recency. Distinguish scheduled bank updates from successful sync.

### F5 — P2: review/rule APIs have no complete user-facing workflow

**Locations:** `worker/index.js:703–714,926–942`; `ui/browser.js` Transactions and bindings.

Source provides rule save/preview/apply and transactions-reviewed APIs. Browser source has no calls to those endpoints or rule-management UI. Fresh Transactions has no Mark reviewed or Manage rules button. The Needs review filter exists, but the user cannot explicitly accept a correct flagged transfer through the corresponding review endpoint.

**Required outcome:** review reasons, accept/correct actions, clear completion count, review reversal, rule preview/scope/edit/disable, and why a category was assigned. All must work on the phone without developer tools.

### F6 — P2: a primary phone task is hidden under Filters

**Location:** `ui/browser.js` `transactions()`.

At 390×844, Add transaction exists but is not visible because it is inside the initially collapsed **Filters · 0 active** disclosure. This was observed in fresh non-sample mode and confirmed in markup. Adding spending is not a filter action.

**Required outcome:** visible Add transaction action beside the page's primary task area; Filters contains filters. Keep import/export secondary and preserve current list placement, touch targets, and focus.

### F7 — P2: manual receipts are forced to Income at entry

**Location:** `ui/browser.js` `addTransactionDialog`; `scripts/check-manual-transactions.mjs:15`.

Source-confirmed: selecting Money received hides category selection and submits Income. Refunds and incoming own-account transfers therefore require a later recategorization. The existing test even labels its income example as a refund from a friend, reinforcing the conceptual mismatch. This is a workflow limitation, not proof that all final totals remain wrong after correction.

**Required outcome:** distinguish income, refund/reimbursement, and own-account transfer when receiving money. Preserve signed-cents arithmetic and existing reimbursement/split contracts. Clarify that recorded account balances are dated observations, not automatically updated by adding a transaction.

### F8 — P2: rule ordering and routing are difficult to trust and maintain

**Locations:** `shared/rules.mjs:8–25`; repeated `category-rules` blocks in `worker/index.js:707,891,918` and stray transactions block at 899.

The rule-score comment promises more constraints win. A synthetic merchant+account+amount rule scores 13,007; a source-only rule scores 32,000 and wins instead. Choose and document the intended precedence before repair.

Three POST rule-handler blocks and a later transactions block referencing out-of-scope identifiers remain in source. An independent fallback transactions request returned 200 through the earlier valid route; do not report the dead block as a reproduced live endpoint failure. Remove redundant/unreachable branches under route contract tests.

## What is already good

- Integer-cent reporting and explicit income/spending/transfer semantics.
- SQLite migrations, atomic write/replay infrastructure, immutable release machinery, and extensive failure/recovery tests.
- Household and personal scopes, budget history, goals, statement review, and housing estimates already exist; this plan does not require another broad feature expansion.
- Current mobile sample Transactions is readable and fits its viewport. Filter counts and separated sample mode are visible. Preserve the green/off-white identity.
- APIs have a foundation for review/rules; finish and correct those workflows rather than replacing the application architecture.

## Definition of household 10/10

Both people can independently answer:

1. What did we spend, and whose records am I viewing?
2. What remains in our plan, and what is still missing or stale?
3. Which bills are due and which payments need attention?
4. Are our savings plans backed by recorded cash?
5. Did my change save, and can I correct a mistake?
6. Are records current and recoverable if the device fails?

Completion requires reliable numbers, discoverable phone tasks, understandable scope, reversible edits, honest status, and tested recovery. More charts, a framework rewrite, dark mode, or a higher automated design score are not prerequisites.

## Implementation sequence

### A. Correct financial automation and preserve history — first

**Addresses:** F1–F3, F8. **Owner:** implementation agent. **Depends on:** none.

1. Preserve each synthetic reproduction as a failing regression, then fix the confidence schema, counterpart validation, and rule-precedence contract.
2. Replace implicit household-specific default activation with explicit reviewed rules/scopes. Preserve existing approved intent; propose a migration/repair preview with counts and amount effects, not a silent recategorization.
3. Ensure rules never override manual choices; define rule editing/deletion and undo semantics including provenance and changed provider facts.
4. Consolidate duplicate routing and extract the rule handlers into a small module if helpful; avoid broad formatting/refactoring.
5. Inspect tracked source/history for personal rule configuration without reproducing sensitive literals. Remove personal configuration from distributable defaults. Ask Peter before any history rewriting; ordinary secret scanners are insufficient for financial prose.

**Exit criteria:** synthetic fee remains $25 spending; LOW confidence appears in review; cross-currency pair is rejected; ambiguous pairs remain visible; scoped rules do not affect another profile unintentionally; rule order is deterministic and documented. Repeat through SQLite reopen and mocked sync, then reconcile exact totals across Overview, Budgets, Transactions, and export. No unintended changes to manual overrides or historical plans.

### B. Complete daily review and manual-entry journeys

**Addresses:** F5–F7. **Owner:** implementation agent. **Depends on:** A's contracts.

1. Put Add transaction in the visible phone action area; expose correction of manual date/amount/account/description with revision checks and dependency handling, rather than relying solely on remove/recreate.
2. Let receipts be income, refunds/reimbursements, or transfers without pretending all receipts are earnings.
3. Build a compact review inbox from the existing Needs review view: reason, suggested action, accept/correct, undo, and progress count. A correct transfer can be accepted without changing its category.
4. Add accessible rule management with exact affected-record preview, owner/account scope, disable/delete, and clear effects on old versus future transactions. Tie application to the preview revision so changed data requires a refreshed preview.
5. Preserve selected-record scope and drafts on conflicts, interrupted responses, reload, and two-person concurrent edits.

**Exit criteria:** add a purchase in ≤30 seconds after account setup; record a refund without inflating income; resolve a correct flagged transfer; disable a wrong rule; correct a manual amount; undo the last action. All survive reload and server restart, and expected IDs/totals match. Repeat core tasks at 390px and with keyboard navigation.

### C. Make status and budget answers trustworthy at a glance

**Addresses:** F4 and comprehension risk. **Owner:** implementation agent. **Depends on:** can start after A while B is sequenced separately.

1. Centralize recovery/sync readiness derivation and use it in Settings summaries, banners, and details. Unknown is not healthy; enabled is not evidence of a successful bank update.
2. At the budget answer, show planned allowance, actual spending, carryover, and data completeness succinctly. Keep account cash distinct from budget allowance; never imply the number is universally safe to spend.
3. Make Household/Peter/Maddie/Joint context explicit at edit controls and explain shared visibility once. First-load personal defaults may follow the signed-in actor, with Household always easy to reach.
4. Keep complex housing/investment explanations expandable; preserve the rough-preview versus complete-save distinction already implemented.

**Exit criteria:** synthetic status matrix covers current verified, stale, failed, missing key/pair, no timestamp, unavailable timer, and sync error; summary/banner/details agree in every case. Both users can explain allowance versus cash and actual versus projected without technical vocabulary.

### D. Polish the phone experience against task evidence

**Owner:** implementation agent, then household acceptance. **Depends on:** B/C.

1. Inspect fresh populated, empty, loading, failed, and stale screens at 320/390/768/1440px. Prioritize Overview, Transactions, Budgets, Bills, and their forms.
2. Keep primary tasks visible; reduce repeated headings/context that push useful records down. Keep filters and technical details secondary, not primary actions.
3. Standardize readable functional typography, money alignment, labels, touch spacing, focus, confirmation language, and status placement. Capture settled patterns in DESIGN.md.
4. Check real keyboard and assistive-technology flow and physical 200% zoom. Automated Axe and viewport tests supplement, not replace, those checks. Do not redesign solely to remove the font advisory.

**Exit criteria:** no clipped amounts/actions or document overflow; comfortable touch targets; visible form errors and retained drafts; zero serious/critical Axe violations in tested states; no unresolved task-blocking keyboard/zoom defects. New rendered screenshots must correspond to the candidate being accepted.

### E. Prove recovery and the chosen data-update workflow

**Owner:** implementation agent for code/rehearsals; Peter for private destination/key/provider choices. **Depends on:** C's honest status; may prepare in parallel with UI work without shared-build contention.

1. Verify encrypted recovery with real age encryption, correct/wrong keys, corrupted ciphertext, and exact synthetic restored data. A complete local bundle and encrypted off-device copy are distinct outcomes.
2. Configure an owner-selected separate-device backup destination; record freshness, retention, and an easy recovery runbook. Proposed targets: ≤24 hours data loss and ≤60 minutes restore on a prepared replacement; confirm practicality with Peter.
3. Rehearse recovery into an empty environment, including matching configuration/key, and independently compare IDs and cents. Never restore over the active store to test this.
4. Choose bank sync or manual/CSV as the actual household workflow. If bank sync is chosen, authorize live connection, verify balances/statement coverage, duplicate prevention and reconnect, then activate scheduling explicitly. If manual/CSV is chosen, provide an obvious last-updated/statement-review routine.
5. Update a single authoritative release/status record after verified activation. Fix README contradictions. Record device/backup encryption boundaries accurately.

**Exit criteria:** recovery works from the separate copy; either person can locate recovery instructions; selected ingestion workflow has a completed monthly reconciliation. Tailscale remains Peter's task.

### F. Final independent acceptance and release

**Depends on:** A–E.

- Run all CI profiles serially on the exact candidate, including every focused browser case and real encrypted-backup test. Report PASS/FAIL/BLOCKED separately; never promote a skipped gate to success.
- Use one synthetic household fixture with Peter, Maddie, and Joint accounts; payroll, credit-card payment, refund, split purchase, transfer, recurring bill, savings goal, stale balance, and bank-response failure. Assert exact identities and cross-view cents, not only successful clicks.
- Repeat two-person simultaneous edits and a commit-with-lost-response/reload recovery. No duplicate records or silent overwrites.
- Run a fresh installed-dependency/advisory and source-boundary/privacy check, plus immutable package/rollback rehearsal.
- After Peter handles access, Maddie tries uncoached phone tasks: identify scope; add spending; find groceries remaining; correct a category and amount; accept a reviewed transfer; check a bill; explain freshness/backup status. Peter uses the same monthly routine. Target all essential tasks complete without intervention, no more than one retry each. Fix observed failures and repeat only failed tasks.
- Use for a full monthly cycle, reconcile statements, and record material discrepancies or workarounds. This validates sustained usefulness beyond a demo.

**Release outcome:** one identified tested commit, truthful deployment record, explicit remaining limitations, and successful household tasks. A score increase alone does not close the plan.

## Scope control

This document is a review and implementation plan, not completed fixes. Work in bounded stages; preserve private records and existing user edits. No automatic bank activation, production migration, history rewrite, or backup destination choice is implied. Maddie's login is Peter-owned. Do not restart old implementation plans wholesale: use the findings and exit criteria above, checking current source before each task.

## Implementation record — 2026-11-08

**Code status:** Stages A–D are implemented in the working tree on top of `4143cf8`. Stages E–F are complete only where the work is code- or test-owned; operator and human acceptance remains open.

- Automatic categorization now has one confidence contract, currency-aware one-to-one transfer pairing, deterministic rule precedence, explicit profile/account scope, and no distributable household-specific defaults. Rules no longer exempt records from review, and manual category choices are protected by `categoryEditVersion`.
- Transactions exposes Add, Needs review, and Manage rules without opening Filters. The review inbox shows reasons, per-row acceptance, remaining counts, and undo. Manual transactions can be edited with revision checks, and received money can be income, a refund/reimbursement, or an own-account transfer.
- One readiness model now drives the Settings summary, banners, top bar, and details. Unknown or incomplete recovery evidence is never healthy; a sync schedule is never treated as successful bank retrieval.
- Phone polish keeps primary transaction actions and the first row visible, removes horizontal page overflow at 320/390/768/1440px, raises primary targets to 44px, and keeps secondary disclosures usable. Settled patterns are recorded in [DESIGN.md](../DESIGN.md).
- A household acceptance fixture now asserts exact combined and per-profile cents for payroll, a credit-card payment, refund, split purchase, own-account transfer, recurring bill, pending row, and non-USD row. Two-person conflicts, lost responses, reload recovery, and immutable release rehearsal remain covered by the existing focused cases.
- `README.md` now presents one owner-reported deployment record, removes the contradictory production-code claim, and marks the readiness checkout as a candidate rather than a deployment.

**Automated acceptance:** all five test profiles pass serially on the tested candidate. The exact fingerprint and per-profile results are recorded in [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md). `npm audit --omit=dev` reported zero known vulnerabilities at the time of this record. Browser acceptance covers keyboard workflows, dialog focus, 720px zoom proxy, zero serious/critical Axe violations, responsive overflow, touch targets, and the focused manual/review/rule case.

**Operational gates still BLOCKED — not code failures:**

- Peter must choose and configure a separate-device encrypted backup destination and complete a real off-device restore rehearsal with independent ID/cents comparison.
- Peter must choose live bank sync or manual/CSV as the household workflow. If live sync is chosen, provider connection, statement coverage, duplicate prevention, reconnect, and scheduling require real acceptance.
- Actual screen-reader use, physical 200% zoom, and uncoached Maddie/Peter phone tasks have not been performed.
- A full monthly cycle with statement reconciliation and a recorded discrepancy/workaround review has not been completed.
- Tailscale login remains Peter's task and is outside this implementation record.

This record does not claim a production deployment, production migration, history rewrite, or completion of the blocked human/operator gates.
