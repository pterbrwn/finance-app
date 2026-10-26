# Ledger browser acceptance and repair playbook

Updated 2026-10-26 for a smaller execution model. Start with [AUTOMATED_TESTING_PLAN.md](AUTOMATED_TESTING_PLAN.md), which defines setup, fixtures, failure cases, runner work, and commands. This playbook specifies what to do in the actual browser.

**Status: planned, not executed in this revision.** Earlier category/scenario repairs were implemented in R06, and R07 records later private deployment and owner acceptance. Preserve those historical facts. The old baseline `43fccbd` and temporary R06 evidence are not current acceptance evidence.

## First priority: incomplete transaction saves

Owner report: changing all transactions did not fully save; the owner stopped testing. Treat this as a P1 acceptance blocker. The executing agent owns reproduction, repair, and regression evidence; more owner testing is not a prerequisite.

The exact interaction is unknown. Test both individual category dropdown edits and selecting many rows for “Categorize selected.” Do not assume “all” means the visible page, all selected rows, or every filtered result.

Source clues at `adb0ba4`, to investigate rather than treat as reproduced diagnoses:

- `refresh()` empties `data.transactions` while `loadTransactionPage()` stores rows in `transactionPage.transactions`. `bindCategories()` looks up the edited row through `rows()`, then reads its override without checking whether it exists. The existing browser suite bypasses this path with a direct API mutation in one category journey.
- The UI displays 50 rows per page, and both selection and bulk API cap batches at 100. Existing browser coverage changes one selected row. It does not establish 100-row persistence or the behavior of “all” across pages.
- Rapid row edits can interact with shared revisions and rerenders. Bulk failure handling and post-save refresh need separate checks: stale display and lost persistence are different defects.

Run B01 and B02 on a fresh SQLite fixture before the broader checklist. If either fails, capture the UI action, exception/network response, requested IDs, actual changed IDs, and reload/restart result. Inspect `ui/browser.js` (`rows`, `refresh`, `loadTransactionPage`, `bindCategories`, bulk handlers), `worker/index.js` (`category`, `category-bulk`, undo), and the transaction subset repository methods. Fix the observed path, not a guessed backend.

## Tool and evidence discipline

Use the installed local `agent-browser` for exploratory UI work and Playwright for repeatable regressions and precise request fault injection. Start by reading:

```sh
agent-browser --version
agent-browser skills get core --full
agent-browser skills get dogfood
```

Follow the installed command syntax; do not invent flags from memory. Use a named session such as `ledger-qa-<run-id>` on the disposable URL from TST-00. Take a fresh `snapshot -i` after navigation, dialog changes, or rerenders before using element references. An old reference pointing at a different row is a test error, not a reason to force-click.

For each journey:

1. Record case ID, fixture, viewport, selected month, and initial relevant state/revision.
2. Perform the action through visible controls. Do not seed the actual action under test through API calls or manipulate DOM values.
3. Check the immediate visible result, status/error, focus, and intended scope.
4. Read back the exact saved records independently; compare IDs and values, including unaffected records.
5. Reload and repeat the visible check. For transaction-save acceptance and designated persistence cases, stop/restart only the disposable server with the same synthetic data directory and repeat.
6. Inspect browser errors/console. Save evidence for failures and a compact result for passes. Any injected error must be specifically identified.
7. Reset fixtures between cases. Do not repair a fixture halfway through a journey and continue calling it the same passing case.

API read-back proves storage, not usability. A screenshot proves display, not persistence. A 200 response or toast alone proves neither end-to-end correctness nor complete scope.

If agent-browser lacks a required capability, reproduce it with local Playwright and label that tool in the report. Do not call a Playwright-only path independently explored by agent-browser. Actual screen-reader output and actual browser zoom remain manual if unsupported.

## Case B01 — Individual transaction category saves (P1; execute first)

**Fixture:** 12 posted USD transactions with unique names, multiple accounts/categories, and known source/override IDs in the selected month. Include one pending row and one refund as additional records. Seed through a fixture; do not edit the categories through setup calls.

1. Open Transactions, change a single row using its rendered category dropdown, and wait for an explicit successful saved result.
2. Check the request/response and persisted override/category ID. Reload. The row, category filter, export, budget spending, and overview must agree.
3. Change every posted row through the row dropdowns, keeping an expected ID → category map. Include two rows with the same merchant label on different accounts/dates; scope them explicitly.
4. Repeat on a reset fixture with ordinary rapid interaction: edit three different rows before earlier replies finish, then edit one row twice. Delay replies to make ordering reproducible. Do not make the test pass by inserting long waits between every action.
5. Navigate away/back, reload, open a fresh browser context, then restart the disposable server using the same state. Compare **every** intended ID and category; verify all other fields and unedited records are unchanged.
6. Exercise F02–F04 on a row edit: failed writes must not leave a false saved label; accepted edits persist and rejected edits retain a clear retry path.

**Pass:** All acknowledged saves persist, the final accepted choice wins for each row, no undefined-row/JS exception occurs, and any rejected/conflicted action is explicit and recoverable. No partial save presented as complete. Capture before/after counts and the exact missing/mismatched synthetic IDs if it fails.

## Case B02 — Bulk selection, complete save, boundaries, and undo (P1)

**Fixture:** 121 matching transactions over three pages at the current 50-row page size, two accounts, duplicate merchant labels, and at least five nonmatching controls. Save a complete expected ID list before mutation.

1. Check one row, choose Shopping, click “Categorize selected,” and verify exactly one changed ID.
2. Reset and repeat with 49, 50, 51, 99, and 100 selected IDs, traversing pages through the UI. Assert selection count, retained selection, category choice, request ID set, response count, persisted ID set, and unchanged nonselected controls.
3. Attempt a 101st selection. Current contract caps at 100: a visible explanation and accurate count are required. No hidden truncation or misleading “all saved.” Test invalid >100 API payload separately: it must reject without a partial write.
4. Complete all 121 rows through two deliberate supported batches (100 then 21); verify all 121 after reload, fresh context, and server restart. A future “all matching” control must specify its scope and deliberately handle the limit; do not silently invent or claim such a control exists today.
5. Select rows, change search/account/category/month or page, then inspect selection count and action scope. Selected hidden rows must be apparent before applying, or selection must clearly reset. A silent change of scope is a usability defect.
6. Bulk-recategorize while filtering the original category. Changed rows should leave that filtered result; count/pagination should recover, including when the last page disappears. Switch to the target filter to verify saved records. Disappearing rows are not evidence of data loss by themselves.
7. Run F01–F05 for apply and an appropriate failure check for Undo. Inspect the committed set before retrying an ambiguous response; duplicate undo batches or overlapping writes are not acceptable.
8. Undo a successful batch and compare each original override/name/ID. Then repeat with one later individual edit before Undo: preserve that later edit and report the undone/skipped counts accurately.
9. Compare visible categories, category-filter membership, downloaded CSV, budget category totals, and overview totals after apply/undo. Overall spending must not change when moving between expense categories.

**Pass:** Selected scope = request scope = acknowledged saved scope = persisted scope, within the explicitly stated limit. Full supported batches survive restart and undo restores the correct history. The reported save issue remains open if any required variant fails or has not run.

## Case B03 — Filters, pagination, history, and export

**Fixture:** Pagination fixture from the automated plan, with one legacy label-only override and one ID-backed custom category; keep deterministic ties.

1. Combine search, account, category, month, date bounds, and Needs review where applicable. Assert exact matching IDs/count, URL parameters, and displayed control values.
2. Move to the last page, change a filter to one match and then no matches. No stranded empty page or invalid page count; clear filters and recover.
3. Use browser Back/Forward, reload, and a direct URL. The same effective query, controls, rows, and counts return. Include invalid month/page/date query input: understandable fallback/validation, no crash.
4. Delay an old search/month response while a newer one finishes (F06). Old results/errors must not replace the latest query or another page.
5. Export from the middle page. Parse the CSV with a CSV parser and compare the exact expected multiset across all matching pages, including quotes, commas, Unicode, refunds, and formula-like merchant text. Check filename and no duplicated/omitted rows; substring checks alone are insufficient.

**Pass:** URL, controls, visible page, total count, and complete filtered export describe the same data. Export preserves safe text formatting without executing spreadsheet formulas.

## Case B04 — Import, preview, cancellation, duplicate, and undo

1. From empty storage, choose a synthetic CSV with custom column names; map columns and select the amount/date conventions. Preview: exact row count and sample amounts; no write before commit.
2. Cancel and Escape separately. State/revision remain unchanged. Reopen, preview, commit, reload, and check exact records and sign conventions.
3. Retry the same import and simulate double-click/ambiguous acknowledgement. No duplicate records. Include unknown category mapping, invalid date/amount, empty file, and mixed valid/invalid rows; errors must explain the actual validation policy without silent loss.
4. Undo that batch, reload, and check only its records are removed; another batch/manual account/history remains. Inspect overlap behavior against existing fixtures rather than assuming every similar row is a duplicate.

**Pass:** Preview is trustworthy, cancellation is inert, import membership is exact, and undo is scoped. If row editing follows import, repeat B01 on an imported row.

## Case B05 — Category identity, archive, restore, and historical access

1. Create two distinct custom categories; assign transactions and a budget to each through the UI. Rename one and reload: stable IDs, assignments, budget history, and no duplicate category.
2. Archive both; independently open the unfiltered Transactions category selector. Both archived historical categories must be discoverable without already knowing their URL. Test direct archived URLs as a separate path.
3. Filter/export each archived category; assert exact membership. New assignments exclude archived choices; an existing historical assignment can remain visibly labeled.
4. Reload before restoring one; restore and verify its ID, budget history, assignment options, focus, and status. The second stays archived.
5. Try empty/whitespace/case-equivalent duplicate and long names; reject invalid input clearly and retain drafts. Exercise reorder and a stale revision.

**Pass:** Stable identity and history survive rename/archive/restore; historical filtering works through normal controls as well as URLs. Do not count sequential archive/restore of one category at a time as coverage of two simultaneously archived categories.

## Case B06 — Budget amounts, mode, history, and failed save

For the separately planned row-based budget redesign, also use BP01–BP12 in [BUDGET_PLAN_VS_ACTUAL_PLAN.md](BUDGET_PLAN_VS_ACTUAL_PLAN.md) when implementing that feature. Those cases add projected income, running deductions, actuals, and outlook; they do not describe the current card-based UI.

1. Set a named category's recurring template to $75 starting this month. Verify prior month unchanged and following month $75.
2. Save a $0 override for this month; switch month/reload. This month remains zero; following month remains $75.
3. Reset override: this month returns to $75. Save blank separately: “no limit” differs from zero. Check a zero-only budget overview for misleading “no budget” text.
4. With F-MONEY Groceries spending $80, use $75 limit: show $5 overspent rather than a misleading positive remainder. Refunds reduce spending.
5. Start a new category while viewing a past month: initial template follows the documented current-reporting-month rule, not invented historical limits.
6. Run F01–F04 on recurring save, month override, and reset. On failure assert the amount **and selected mode/month** remain correct; retry cannot apply a monthly draft as a recurring template.

**Pass:** Exact amounts and history persist, blank/zero/reset remain distinct, and failures cannot silently change the scope.

## Case B07 — Accounts, balance sheet, and Investments

Use the account fixture in the automated plan. Create/edit records through Accounts; check visible balance-sheet totals ($13,000 assets, $2,000 liabilities, $11,000 net worth).

- Verify blank/unknown versus $0 balances; observation date, type, and currency persist after reload. Reject invalid dates/amounts with a retained draft.
- Cancel then accept archive separately; archived records leave active totals and Restore returns them. Exclude/include has its documented reporting effect without deleting history.
- Investments/retirement/liabilities must not become eligible goal cash. Check Investments with empty holdings, synthetic holdings, stale and failed update fixtures. No real provider requests.
- For mocked connected accounts, distinguish unlink (retains saved history) and delete-history (separate explicit irreversible intent). Test cancel and accepted deletion only on disposable synthetic records.

**Pass:** Visible classifications, totals, freshness, and persistence agree. No action affects unrelated accounts or records.

## Case B08 — Goals and allocation constraints

1. Create goals A/B with explicit priorities, targets, future due dates, contribution/APY inputs; reload/edit and compare.
2. Reserve $700/$500 against $1,000 eligible fresh cash. A gets $700 fresh backing and B at most $300; combined backing never exceeds $1,000.
3. Repeat with archived/excluded/stale cash and negative/missing available balances. Show provisional/unavailable values honestly; investments and liabilities cannot inflate fresh backing.
4. Check due-today, current month-end, and past-date cases against fixed-date unit/API oracles; verify the browser's contribution schedule matches its recorded reporting date.
5. Cancel/save allocation and goal edits; run failure matrix. Reload preserves allocation amounts, priority, and date, not merely the goal name.

**Pass:** Funding, reservation, shortfall, and projection are distinct and numerically consistent across Overview, Goals, and linked scenarios.

## Case B09 — Scenario form, calculation, comparison, and apply

1. At 1280×577, open a blank scenario. Fill main loan/ownership fields, leave required closing costs in their collapsed section, submit. The first missing required field becomes visible/focused with a useful error; prior input survives.
2. Fill explicit zero costs through normal controls. Check blank versus zero, invalid/negative inputs, PMI none, and unknown income. Incomplete estimates must not appear complete.
3. Use the existing fully specified golden finance fixture: $88,000 cash to close, $2,022.62 P&I, $3,047.62 ownership outflow. Copy its inputs from `check-finance.mjs`, record them in the case, and assert these independent outputs as well as preview/saved parity.
4. Save/reload/reopen/edit, duplicate and change one meaningful assumption; compare two scenarios and assert the actual differing values, not only the existence of a comparison box.
5. Link a funded goal and check preview versus saved funding. Saving/duplicating a scenario alone must not change goal or Housing budget.
6. For “Create/update down-payment goal” and “Set Housing budget,” dismiss confirmation first (no change), then accept (only intended record/value changes). Repeat an action to verify update/no duplicate behavior.
7. Run save/apply failures and reload; compare every relevant input/version and side effect.

**Pass:** Discoverable form, independent correct amounts, complete persisted inputs, and deliberate scoped apply actions. No auto-accept handler can stand in for these checks.

## Case B10 — Property and mortgage records

Create a synthetic property and fixed-rate mortgage with a known statement balance/as-of date and supported projection inputs. Verify statement balance stays distinct from projected balance and escrow is counted once. Edit/reload, cancel and accept archive, then restore. Add unsupported interest-only/ARM or incomplete variants: clearly unavailable projections, no invented schedule. Verify associated property and net-worth presentation follows stored statement/value records. Use existing mortgage math fixtures for exact amounts; do not infer correctness from a chart appearing.

## Case B11 — Empty, loading, saved/error, Settings, and sample mode

Visit all eight views: Overview, Transactions, Budgets, Accounts, Investments, Goals, Home planner, Settings.

- Start with empty, manual-only, budget-only, and populated fixtures. No sample transactions unless explicitly requested. Empty state contains a usable next action.
- Inject initial load failure, delayed load, saved-data refresh failure, and recovery (F07). No misleading empty/zero state while a known saved dataset is unavailable.
- Mock deterministic sync/backup status: disabled/not-run, in-progress, success with timestamp, failed/stale, and runtime unavailable. Labels match fixtures; action enablement matches local-only capability. Keep previously saved data visible on update failure.
- Explicitly enter sample mode, make supported sample edits, then exit/reload: persistent state/revision unchanged. Controls must not imply unsupported sample operations succeeded. Sample labels stay visible.
- No test enables systemd timers, connects a real bank, or performs live sync.

## Case B12 — Keyboard, viewport, long content, and accessibility

Test every view at 1440×900 and 390×844. At 320×800 inspect every view plus transaction/budget/category controls; at 1280×577 inspect scrolling scenario/import/account dialogs. Include long and duplicate synthetic names, large/negative amounts, errors, populated tables, and empty states.

For each viewport check readable unclipped amounts, reachable actions, focus visibility, unobstructed modal buttons, no document-level horizontal overflow, and intentional table scroll regions usable by keyboard. Measure relevant mobile controls against the existing 44 px target. Do not only test navigation button height.

Perform keyboard-only transaction edit, import, category create/restore, budget save, account edit, goal/allocation, and scenario journeys. Check initial modal focus, Tab/Shift+Tab containment, Enter behavior, Escape/cancel without a write, and focus return to the opener or logical successor after rerender. Native confirmation accept/dismiss gets explicit evidence.

Run axe on every view and key open dialogs, including validation/error states; gate serious/critical issues and record lesser findings. Check chart data alternatives against the same totals. Use the 720 CSS px reflow check as a **proxy**, labeled as such. Actual 200% browser zoom and screen-reader announcements require manual evidence or remain BLOCKED; R07's historical acceptance stays recorded separately.

## Case B13 — Interrupted workflows and ordinary exploratory use

Spend one bounded 20–30 minute exploratory pass after deterministic cases pass. Use the app like a new user: import, correct several categories quickly, edit a budget, change month, inspect accounts/goals, and return. Try switching views while requests are pending, pressing Escape after typing, back/forward, reopening a dialog, and recovering from a failed save.

Record friction as well as hard errors: unexplained scope, invisible save state, lost focus/draft, unreachable controls, stale totals, ambiguous zero/unknown amounts. Label a UX improvement separately from a correctness defect. For an uncertain expected behavior, consult the documented contract; do not normalize silent data loss as a design choice.

## Defect record and stopping rules

Use one record per defect:

```text
ID / originating case:
Priority: P0 data/privacy loss | P1 wrong/unsaved data or blocked core flow |
          P2 recoverable usability/accessibility problem | P3 polish
Classification: owner-reported | source risk | reproduced | intermittent |
                harness/environment issue | improvement
Candidate/backend/browser/viewport/reporting date:
Synthetic fixture and initial state:
Exact visible steps:
Expected:
Observed:
Requested IDs / acknowledged IDs / persisted IDs (for saves):
Screenshot/trace/console/network evidence:
Reproduction count:
Smallest suspected code boundary (not an asserted root cause):
Regression + before/after result:
Remaining risk or next action:
```

Reproduce deterministic defects twice from reset state when practical. For a race/intermittent partial save, keep the first trace and block acceptance; inability to repeat twice does not erase it. Bound diagnosis: after two unsuccessful repair attempts, reread the relevant handler/contract and record hypotheses and evidence before changing more code. Do not repeatedly guess selectors or widen the change.

Stop dependent acceptance on P0/P1 failures, especially B01/B02. Continue independent coverage and report every failure/blocker. Do not deploy, waive a failing assertion, or ask the owner to complete routine automated QA. “Not reproduced” does not close the owner's report without coverage of the plausible paths and explicit limits.

## Final handoff and ready-to-use execution prompt

Produce a case matrix for B00–B13 and F01–F07 (B00 is the TST-00/TST-01 setup/runner gate), status counts, repaired defects, unresolved failures, and evidence paths. Distinguish automated versus exploratory versus manual acceptance. Update the progress log without rewriting previous results.

> Work in /home/peter/Development/finance-app. Execute docs/AUTOMATED_TESTING_PLAN.md and docs/AGENT_BROWSER_REPAIR_PLAN.md serially. The owner's incomplete transaction-save report is the first P1 blocker: after isolated setup, reproduce B01 individual/rapid row edits and B02 bulk edits across pages and the 100-row boundary. Own the QA; do not wait for more owner testing. Fix only evidenced defects and add regressions that fail before and pass after the repair. Verify every intended ID after reload, fresh context, and restart of the disposable SQLite server. Preserve existing JSON/API coverage. Then complete the remaining task queue, browser/error/recovery cases, and final gates. Use pinned Node 24.22.1 and synthetic isolated data; do not change production, sync banks, or deploy. Record PASS/FAIL/BLOCKED/NOT_RUN with artifacts and an exact next step. Never claim the experience is tested from HTTP success, toast text, one edited row, or the old suite alone.
