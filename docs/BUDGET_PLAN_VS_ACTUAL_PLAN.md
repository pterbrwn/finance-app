# Monthly budget: projected income versus reality

Prepared 2026-10-26. **Implementation is underway; see the R10 verification entry in [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md) for completed scope, test results, and remaining acceptance cases.** This remains the product contract and execution handoff. Read alongside [the automated testing plan](AUTOMATED_TESTING_PLAN.md) and [browser playbook](AGENT_BROWSER_REPAIR_PLAN.md).

## Requested outcome

Replace the budget card grid with a compact list of rows. Start the selected month with projected take-home income, subtract each planned expense bucket, and show whether the plan leaves a surplus or deficit. As income and spending transactions arrive, update the actual column and the current outlook automatically while retaining the saved plan for comparison.

The owner should be able to answer:

1. How much income do I expect this month?
2. After each bucket, how much of that income is still unallocated?
3. Am I planning to spend more than I expect to receive?
4. What have I actually received and spent, and where am I over or under each bucket?
5. With what has happened and what is still expected, what is the current month-end outlook?

Use the defaults below without waiting for more owner QA. They are product decisions for this implementation, not claims that these features exist today. The transaction-save defect remains the first acceptance blocker: verify B01/B02 from the browser playbook before relying on recategorization to update these totals. Planning and independent budget work can proceed, but acceptance must not bypass that defect.

## Page layout and editing

Use one month header and one compact table/list with thin separators. No individual bucket cards, repeated headings, repeated full-size forms, or decorative dashboard tiles on this page.

- Header: month picker with previous/next controls; allow any valid month, including a future month without transactions or existing plans. Include the selected month in the URL and browser history.
- Income row first: editable **Projected income** for the full month, and read-only **Received so far** from transactions. Use expected net deposits/take-home income, not gross salary. Start blank; never infer a committed income plan from deposits, account balances, or a mortgage scenario's income field.
- Bucket rows: **Bucket**, **Planned**, **Spent so far**, **Left in bucket**, **Income left after bucket**. The last column subtracts that row and all preceding planned buckets from projected income. Explain once that it is the planned allocation balance.
- Total row: total planned expenses, actual spending, and remaining planned spending. Final line: **Planned surplus $X**, **Planned deficit $X**, or **Fully allocated $0**. For a deficit, use its positive magnitude with the word deficit; never rely on color alone.
- A compact comparison below the rows: **Actual net so far** and **Expected month-end surplus/deficit**, with the assumptions described below. Do not label midmonth actual net as the final month result.
- Keep category management in a secondary section or dialog. Add bucket uses the existing stable category identity. Reordering changes the running balance presentation, not the final totals.
- Income and bucket edits expand in place or use a small accessible editor. Default scope to **Only this month**, with an explicit **Recurring from this month** choice. Show whether the saved value is recurring or a month override. Keep **Reset month override** separate from clearing an amount.
- Each save has clear saving/saved/error feedback. Update the saved-plan totals after successful acknowledgement. A draft preview is allowed only if visibly marked unsaved; never show an unsaved number as the persisted plan. Cancel/Escape preserves the previous saved value.
- Actual amounts link to the matching month's transactions with the relevant category/date filters. These links must include all matching rows, not only the current transaction page.

Desktop example, all numbers synthetic and in dollars:

| Line | Planned | Actual so far | Left in bucket | Income left after bucket |
| --- | ---: | ---: | ---: | ---: |
| Income | 5,000 | 2,500 | — | 5,000 |
| Housing | 1,800 | 1,800 | 0 | 3,200 |
| Groceries | 600 | 650 | -50, over | 2,600 |
| Transport | 300 | 100 | 200 | 2,300 |
| Utilities | 200 | 0 | 200 | 2,100 |
| Other | 200 | 50 | 150 | 1,900 |
| Expenses | 3,100 | 2,600 | 500 | — |

Below: **Planned surplus $1,900 · Actual net so far -$100 · Expected month-end surplus $1,850**. Explain the outlook: $5,000 expected total income less $3,150 expected total spending, including the $50 grocery overrun. A separate unspent Utilities bucket does not cancel the overrun unless its remaining expectation is explicitly reduced.

At 390/320 px retain rows with subtle separators. Show Plan/Actual prominently, with labeled secondary lines for bucket remaining and running income balance. All amounts/actions must be reachable without document horizontal scrolling; do not recreate the old card grid on mobile. Use semantic table headers or equivalent accessible relationships, visible focus, and text indicators for over/under.

## Calculation contract

All persisted/calculated monetary values use integer cents and checked safe-integer arithmetic. Use the existing money utilities for decimal parsing/formatting; do not introduce floating-point sums. Month boundaries use the existing America/Chicago reporting calendar and transaction date semantics.

### Saved plan

For a selected month, let P be resolved projected income and B[i] each resolved planned expense amount.

- Planned expenses = sum of all known B[i].
- Planned balance after row k = P - sum(B[i] through row k).
- Planned surplus/deficit = P - planned expenses.
- Income plans follow the existing budget precedence pattern: explicit month override, otherwise latest recurring template effective on/before the month, otherwise unknown.
- Blank projected income is **unknown**, not $0. Do not show a numeric planned surplus or running balance until income is known. An explicit $0 income plan is valid and produces a deficit if expenses are planned.
- Existing bucket blank/null still means **no limit / not planned**. Explicit $0 is a real plan with zero allowed spending. Do not convert legacy nulls into zero budgets. For null rows display **Not planned** and no numeric bucket variance.
- Row membership is the union of categories with a resolved non-null plan and categories with actual activity; unplanned spending must remain visible. Allow adding unused active buckets without forcing every system category into the main table. Count gross activity as well as net values so a purchase/refund pair totaling zero is still discoverable.
- If actual spending exists in an unplanned category, label the plan **Incomplete: unplanned spending**. Show the balance as **Unallocated before unplanned expenses**, not a confident under-budget verdict. Include that spending in actual totals and the outlook. Unknown future expenses cannot be estimated automatically.
- Preserve stored month overrides, effective dates, and the legacy history-unavailable boundary. Do not backfill plans for earlier months or write a historical plan simply by viewing it.

### Actuals and variance

- Actual income A = net posted USD income for the selected month, using the effective category. Actual spending S[i] = net posted USD expense spending in that category. Refunds reduce S[i] and may make it negative.
- Pending/non-USD records are excluded from monetary totals and identified as excluded where useful. Transfers, account balances, credit-card payments classified as transfers, and goal allocations are not income or expense additions.
- Bucket remaining = B[i] - S[i] when B[i] is known. A negative result means over that bucket by its magnitude. Income still to reach plan = P - A; a positive value is income not yet received, not income already available.
- Actual net so far = A - sum(S[i]). This is monthly net cash flow, not a bank balance or money available to withdraw.
- Past-month actual net can be compared with the saved planned net: actual-net variance = actual net - planned net; positive is better than plan. Label income/expense variances explicitly because their favorable directions differ.
- Actuals never rewrite saved plan values. A user can deliberately revise a plan, and then comparison uses that revised saved plan. An immutable original-plan audit/version history is outside this iteration; do not claim it exists.
- Totals must agree with Overview and the complete transaction set after imports, import undo, single/bulk category edits and undo, provider fixture updates, or transaction removal. Keep the existing reporting eligibility rules consistent across views; do not add an account-exclusion rule to only this page.

### Updated month-end outlook

Keep **Plan**, **Actual so far**, and **Expected month end** distinct. The first two are the required primary experience; the outlook is a transparent remaining-budget estimate, not a statistical forecast or guaranteed result.

For the current or a future month, default remaining income R = max(P - A, 0), when P is known. For each planned bucket, default remaining spending E[i] = max(B[i] - S[i], 0). For an unplanned bucket, include its actual spending, assume no additional amount, and show the incomplete-estimate label.

Expected total income = A + R. Expected total spending = sum(S[i] + E[i]). Expected month-end net = expected income - expected spending. Thus spending above plan worsens the outlook immediately; receiving a planned paycheck consumes the remaining income instead of being added on top of a full month's projected income. Never calculate expected income as P + A.

Refunds replenish the default remaining bucket allowance. If a category has no more spending expected, the user can set its remaining expectation to $0; its net refund is then retained in the outlook. Income reversals similarly reduce actual income and may increase the default remaining amount. State these budget-based assumptions in a short expandable explanation.

Provide a secondary **Adjust what's still expected** editor for the selected month: remaining income and remaining spending per bucket. This is necessary when a paycheck is canceled, a bill is finished below budget, or a further expense is now known. Do not force routine transaction-by-transaction matching or income schedules.

- Blank remaining adjustment resets to the default; explicit zero means nothing more expected. Adjustments are non-negative cents and apply only to the selected month.
- Persist each adjustment as an expected final total equal to the authoritative actual at save time plus the entered remaining amount. On subsequent refresh, remaining = max(saved expected total - current actual, 0). This consumes the adjustment as transactions arrive; do not persist an unchanged remainder that gets counted again after each paycheck/bill.
- The saved expected total can be signed if actuals are negative. Expected total on display is current actual plus the computed remaining. Record the actual basis/revision used for the edit; reject a stale adjustment instead of calculating it against different unseen actuals.
- Show which lines have adjusted expectations and allow resetting them without changing their saved plan. If the user edits a plan with an outlook adjustment present, keep the explicit adjustment and label that it still controls the outlook until reset.
- An unknown projected income yields an unavailable default income outlook; an explicit remaining-income adjustment can supply an outlook while the planned-income column remains unknown.
- For a past month, use actuals for the month-end result and zero remaining expectations regardless of prior outlook adjustments. Label it **Actual month result**, with data freshness/coverage rather than implying all bank data is necessarily complete. Late-arriving transactions still update it. Future months use their resolved plans and any real posted activity without inventing income received.

Do not automatically carry last month's surplus into this month's income, transfer money between buckets, allocate goals, or use daily spending-rate extrapolation. Those require distinct product decisions and are not needed for this request.

## Category identity and archived history

Resolve amounts using stable category IDs; names are display labels. The current month summary groups by effective names, so reconcile legacy label-only rows with the catalog once in a shared boundary, or return stable-ID aggregates with a consistent legacy fallback. Empty overrides fall back to source categories. Test JSON and SQLite parity; do not create a third category-matching implementation in the UI.

Archiving must not silently remove real spending or saved planned amounts from the selected month's comparison. Show archived categories when they have a plan or actual activity, with a muted archived label. Archive is not an implicit cancellation of a recurring expense plan. Provide an explicit **Stop planning from this month** operation using a null recurring template effective in that month; preserve earlier plans and month overrides. Permit clearing a plan for an archived category without restoring assignment eligibility, with the same revision checks. Existing overrides remain visibly effective until reset. Rename/archive/restore/reorder must not change final plan/actual totals by themselves.

This is an intentional clarification of the existing active-category-only budget presentation. Align the budget-related Overview summaries with this rule; do not change unrelated transaction/account archive policy. Test that simply upgrading or loading the page does not mutate old templates.

## Suggested implementation boundaries

These fields/routes/helpers are **proposed**, not existing APIs. Adapt naming to repository conventions while retaining the contracts. Work in small serial tasks; no framework migration.

| Boundary | Work |
| --- | --- |
| `shared/budgets.mjs` or a small adjacent module | Pure resolution, row composition, running balance, completeness, variance, and outlook helpers. Accept explicit month/as-of data; no hidden wall-clock assumptions in arithmetic. |
| `server/repository.mjs` and `server/sqlite-repository.mjs` | Default and validate new income/outlook state; preserve through full and transaction-subset mutations, bounded dashboard reads, restart, import, backup, and restore. Return consistent aggregate semantics. |
| `worker/index.js` | Revision-checked income/outlook mutations and selected-month budget summary. Reuse existing expense budget save/reset semantics. Validate archived plan cancellation explicitly. |
| `ui/browser.js` | Replace `budgetPage()` cards; income/month editing; actual transaction links; guarded async refresh; saved-state indicators and retained drafts. Align relevant Overview/budget helpers. |
| `ui/styles.css` | Compact row layout, aligned numeric columns, responsive labels, accessible errors/focus. Keep unrelated page styles scoped. |
| `scripts/build.mjs` | Add any new shared browser module to server/static asset packaging and its strict allowlist. Do not forget generated/release artifacts. |

Proposed state additions:

```text
incomePlanTemplates: [{ effectiveFrom: YYYY-MM, amount: cents | null }]
monthlyIncomePlans: { [YYYY-MM]: cents | null }
monthlyBudgetOutlooks: {
  [YYYY-MM]: {
    income: { expectedTotal, actualAtEdit, updatedAt } | absent,
    expenses: { [categoryId]: { expectedTotal, actualAtEdit, updatedAt } }
  }
}
```

Absent properties in older records resolve to empty collections. Missing override differs from a present null override; null blocks inheritance and means unknown/unplanned. Clearing a recurring income plan uses an effective null template; deleting a month override restores inheritance. For outlooks, absence means default and explicit remaining zero saves a target equal to actual at edit time.

The current SQLite adapter persists additional metadata through `state_meta`; prefer using that existing mechanism for this small state if validation and round-trip checks establish compatibility. Do not add a SQL schema migration without a concrete need. Audit full mutation, scoped transaction mutation, importer, backup/restore, and packaged build paths; an in-memory field alone is insufficient.

Prefer a bounded `GET /api/budget-summary?month=YYYY-MM` response containing resolved plan sources, row actuals/activity, running balances, completeness, outlook assumptions, revision, and freshness. Read plan/actual inputs at one consistent repository revision/snapshot. Do not assemble them from unrelated racing reads or download all transactions to the browser. Proposed POST income-plan, income-plan-reset, and budget-outlook endpoints use the existing expected-revision contract. Reject invalid months, amounts, modes, categories, duplicate effective templates, and stale revisions without partial writes. Never accept user-supplied actual totals as authoritative.

Refresh the visible selected-month summary after successful mutations/import/undo and observed sync completion, on returning to the page, and on tab focus; refresh across tabs using an existing mechanism or a small revision-aware mechanism. Scope response application by month and request generation. A late October response must not overwrite November. Keep an editor's drafts while totals refresh; on a failed refresh show previous saved data with an explicit error/freshness label, not false zero values.

## Serial task queue

Record status, changed files, focused checks, evidence, and next step in the progress log. Use the isolated Node 24.22.1/synthetic-data procedure in the automated testing plan.

| Task | Deliverable | Completion gate |
| --- | --- | --- |
| BUD-00 | **PARTIAL** — source review, explicit calculation contract and initial B01/B02 regressions exist. Full B01/B02 failure/race/restart matrix remains. | No unacknowledged save-integrity blocker; test inputs and expected values are explicit. Independent design/math work may proceed while repairs run serially. |
| BUD-01 | **IMPLEMENTED; focused checks pass** — income resolution, plan/actual/outlook calculations, checked integer-cent arithmetic and unknown/zero handling. | Independent arithmetic and blank/zero/date/legacy tests pass. No UI-dependent expected values. |
| BUD-02 | **PARTIAL; focused checks pass** — income/outlook state, month summary endpoint, revision conflict and SQLite metadata round-trip are covered; full mutation/subset, backup/restart parity remains. | JSON/SQLite parity, conflict, reload/restart, subset-mutation and synthetic backup/restore checks pass. |
| BUD-03 | **IMPLEMENTED; browser coverage partial** — compact separated rows, projected income, running balance, monthly/recurring controls, actuals and zero/reset path. Full BP-F1 five-bucket oracle, month-boundary, and all data-change paths remain. | Browser BP01–BP05 pass with actual visible amounts and saved-record evidence. |
| BUD-04 | **PARTIAL** — saved remaining expectations and stale actual-basis rejection are covered by API/calculation tests; full UI adjustment and actual-arrival matrix remains. | BP06–BP09 pass, including arrivals consuming remaining estimates and no double counting. |
| BUD-05 | **PARTIAL** — responsive/keyboard/Axe gates run; full failure injection and manual zoom/screen-reader evidence remain. | BP10–BP12 plus final relevant gates pass; unresolved failures remain explicit. |

Do not implement optional payroll schedules, bank-balance forecasting, carryover/envelopes, goal transfers, drag-and-drop, or charts as prerequisites for these tasks. The plan/actual comparison and dependable saving are the priority.

## Independent examples and acceptance tests

Use the exact desktop example above as fixture BP-F1. All unmentioned transactions are absent. Freeze or explicitly set the selected reporting month; exercise the real UI for the edits under test.

| Case | Actions and required outcome |
| --- | --- |
| BP01: initial planning | Set projected income $5,000 and the five bucket amounts in BP-F1. Total planned $3,100; running balances $3,200/$2,600/$2,300/$2,100/$1,900. Reload/restart reproduces every input and result. Reorder rows: intermediate balances change, final $1,900 does not. |
| BP02: deficit/zero/unknown | Income $3,000 with the same buckets yields $100 planned deficit. Explicit income $0 yields $3,100 deficit; blank yields unknown, never a $3,100 deficit or $0 surplus. A zero-only expense plan displays fully allocated when income is also zero; it is not “no budget.” |
| BP03: month scope | Create recurring income $5,000 from October and a November override $4,800; earlier unplanned months stay unknown, December resolves $5,000. Reset November to $5,000. Explicit null November stays unknown until reset. Repeat expense template/override/zero/null/reset. Open a future month with no records. |
| BP04: actuals | Add the posted actual transactions from BP-F1. Actual spending $2,600, actual net -$100, grocery remaining -$50, total planned minus actual $500, original planned surplus still $1,900. Pending, transfer and CAD fixtures do not change these numbers; their exclusions remain understandable. |
| BP05: correctness across views | Recategorize Groceries spending into another expense bucket through single and bulk UI editors. Category totals change, total actual spending/net do not. Import undo, bulk undo and fixture removals propagate correctly. Compare all IDs across pages and Overview/Transactions/Budgets, not one visible row. |
| BP06: default outlook | BP-F1 yields remaining income $2,500 and remaining spending $550, expected spending $3,150 and surplus $1,850. Receive another $2,500: expected income stays $5,000 and remaining income becomes zero. Receive $500 extra: expected income becomes $5,500, not $10,500; outlook surplus $2,350. |
| BP07: revised expectations | Reset BP-F1. Enter remaining income $2,200: expected total income $4,700 and surplus $1,550. A later $1,000 deposit leaves $1,200 remaining and keeps expected total $4,700. Set Utilities remaining to zero: outlook improves by $200 without changing its $200 plan. Reset that adjustment: planned remaining returns. |
| BP08: unplanned/refund/archive | Add $40 unplanned spending: actual spending $2,640, actual net -$140, outlook $1,810 with an incomplete label, and an unplanned row remains visible. Separately refund $50 of BP-F1 groceries: net Groceries $600, expected total spend $3,100, outlook $1,900. Test refund greater than purchase, purchase/refund net zero, legacy label-only override, empty override, renamed and archived categories. Plan/actual sums remain fully reconciled; no omitted expense. |
| BP09: historical result | For a past month with plan income $5,000/expenses $3,100 and actual income $4,800/expenses $3,300: actual month result $1,500, planned surplus $1,900, variance $400 worse. Old remaining adjustments must not inflate the past result. Late actuals recalculate it; December/January and Chicago month boundaries select the correct period. |
| BP10: failed/conflicting saves | Inject abort, 500 JSON, 502 text, real two-tab 409, slow/double submit, and commit-with-lost-response using F01–F05. Income amount, scope, month, bucket and outlook drafts survive. A stale remaining-expectations edit cannot use a changed actual basis silently. Retry saves once; read back all values after reload/restart. |
| BP11: async refresh | Change month during a delayed summary; newer selected month wins. Import/recategorize in another tab then refocus Budgets: actuals/outlook update, unsaved plan draft survives. Initial-error, stale-refresh, empty and sample modes remain distinct. Sample edits never persist to real state. |
| BP12: layout/accessibility | At 1440/390/320 px, inspect rows with long/duplicate names, negative/large values, unknowns, errors and expanded editors. Keyboard edit/save/cancel/reset; useful focus return, labeled numeric inputs/headers, announced failures, no clipped amounts/document overflow. Axe serious/critical gate; actual zoom/screen-reader evidence reported separately. |

Add tests to the smallest appropriate existing finance, SQLite, HTTP, backup and browser boundaries. Do not treat identical preview/saved text as an independent arithmetic oracle. Record failing-before/passing-after evidence for discovered defects. Cover plan and outlook metadata surviving a later unrelated transaction subset write; that path must not erase them.

Final integrated checks in a fresh disposable source copy: `npm run check`, `npm run check:local-http`, `npm run check:browser`. Inspect `git diff --check` and the final patch. Re-run performance measurements only if aggregate/query changes or observed stalls justify them. Do not deploy or modify owner records as part of implementing/testing this plan.

## Execution prompt

> Continue docs/BUDGET_PLAN_VS_ACTUAL_PLAN.md from the R10 state in docs/IMPLEMENTATION_PROGRESS.md. Complete the remaining BUD-00–BUD-05 acceptance matrix, especially B01/B02 rapid/failure/restart variants and BP-F1/BP06–BP12. Preserve the isolated synthetic test setup and record evidence. Do not deploy or operate on private data.
