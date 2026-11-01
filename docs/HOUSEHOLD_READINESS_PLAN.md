# Household readiness plan

Goal: make Ledger something a non-technical household member (Maddie) can use alone, and get the test suite honestly green again.

Source review: 2026-11-01, commit `3c8ff9d`. Line numbers below are from that commit. **Always re-find code with `grep` before editing; do not trust line numbers after the first edit in a file.**

## 0. Rules for the implementer (read first)

1. **Never use real data.** Do not read `~/.local/state/ledger`, `~/.config/ledger`, or the running service. Tests and manual checks use only the synthetic servers the test scripts start.
2. **Do not deploy, restart the service, change systemd, or touch Tailscale.** Peter does that (section WP10).
3. **Do not commit or push** unless Peter asks. The git hooks require `gitleaks`; never bypass them with `--no-verify`.
4. **Run test profiles one at a time, never in parallel.** They all rebuild `dist/`, and parallel runs fail with `ENOENT ... dist/shared/...`. Use a writable temp dir:
   `mkdir -p ~/.cache/ledger-tests && export TMPDIR=~/.cache/ledger-tests`
5. **Commands** (run from the repo root, `/home/peter/Development/finance-app`):
   - Single node check: `bash scripts/run-node.sh scripts/<file>.mjs`
   - A profile: `npm run test:fast`, `test:integration`, `test:recovery`, `test:browser`, `test:release`
   - One browser case: `BROWSER_CASE=<name> npm run check:browser:case` (names are in `scripts/browser-cases.mjs` line 11)
   - Rebuild after UI/server edits: `npm run build`
6. **`ui/browser.js` is 341 very long lines (about 250 KB).** Never reformat it and never rewrite whole lines. To change text, find the exact fragment with `grep -n -F "<fragment>" ui/browser.js`, then use the edit tool with the smallest unique `oldString`. If a fragment is not unique, include more characters on both sides.
7. **Before changing any visible string, search the tests**: `grep -rn -F "<old text>" scripts/ docs/ README.md`. Tests assert on visible text. Update them in the same change.
8. **Keep the existing style**: terse, no new comments, no new dependencies. Money is integer cents. Dates are `YYYY-MM-DD` strings in `America/Chicago`.
9. **Work in the order of the work packages (WPs).** Finish and verify one before starting the next. After each WP, run the verification listed in it and stop if anything fails; do not "fix forward" across WPs.
10. **Sample mode (`demo` flag in `ui/browser.js`) must never send a write request.** The browser test asserts `sampleWrites` is empty. Every new button must be disabled or hidden in sample mode.

## 1. What was found

| # | Finding | Severity | WP |
|---|---|---|---|
| 1 | Five tests fail because they depend on today's date (Nov 1). `npm run test:ci` is not green. | P1 | WP1 |
| 2 | A commitment (bill) payment match cannot be undone or replaced. API returns 409 "already matched". | P1 | WP2 |
| 3 | There is no way to add a transaction by hand. Without Plaid, the only way in is a CSV file. | P1 | WP3 |
| 4 | Wording is written for the developer ("bucket", "Posted USD", "Plaid credentials ... Jetson"). | P1 | WP4 |
| 5 | An empty dashboard offers three buttons and no guided first steps. | P1 | WP5 |
| 6 | 22 native browser `confirm()` pop-ups. | P2 | WP6 |
| 7 | "1 purchases"; sample data uses UTC date; other small items. | P2 | WP7 |
| 8 | Maddie's Tailscale login is not configured (README). She cannot reach the app yet. | blocker | WP0 |

Definition of done for the whole plan:
- `npm run test:ci` passes from a clean checkout.
- Maddie completes the trial script in WP9 without asking Peter for help.

## WP0. Operator prerequisites (Peter, not the implementer)

Peter does these by hand; the implementer only needs to know they exist.
1. In `~/.config/ledger/config.json` add Maddie to `tailscaleMembers`: `{"login":"<her tailscale login>","actorId":"maddie"}` (see `scripts/runtime.mjs` lines 53-60 for validation rules). Keep file mode `600`. Restart the service.
2. Install Tailscale on Maddie's phone and laptop, sign in as that login, open the private HTTPS address, and use "Add to Home Screen".
3. Decide whether Plaid will be enabled. If not, WP3 is how she gets data in.

## WP1. Make the test suite honestly green

Why: five checks fail today. Read each cause below, apply the fix, then run the single check.

### WP1.1 `scripts/check-finance.mjs` mortgage projection (line 468)

Cause: `projectedBalanceAtStatement` counts calendar months from origination `2020-10-25` to today. The test hard-codes `4800000`, which was only true in October 2026. Today it returns `4700000`.

Fix: replace the hard-coded number with one computed from `reportingDate` (already defined at line 47 of this file).
- Find: `assert.equal(projection.projectedBalanceAtStatement,4800000,'statement comparison uses modeled elapsed monthly payments');`
- Replace with:
```js
const [statementYear,statementMonth]=reportingDate.split('-').map(Number),elapsedPayments=(statementYear-2020)*12+(statementMonth-10);assert.equal(projection.projectedBalanceAtStatement,12000000-elapsedPayments*100000,'statement comparison uses modeled elapsed monthly payments');
```
The loan in this test is zero-rate, 120 months, `$120,000.00` principal, `$1,000.00` principal per month, so the balance after `n` payments is `12000000 - n*100000`. This stays correct until 2030.

Do not change `shared/mortgages.mjs`. (Open product question, do not act: it ignores day-of-month when counting elapsed payments. Note it in the PR description for Peter.)

Verify: `bash scripts/run-node.sh scripts/check-finance.mjs` prints no assertion error.

### WP1.2 `scripts/check-sqlite.mjs` line 144 (`0 !== 73000`)

Cause (confirmed by reading `worker/index.js` lines 61, 422, 431): budget carryover only counts history from `state.budgetHistoryUnavailableBefore`, which defaults to the current month. The test saves budgets for `2026-10` and expects carryover into `2026-11`. That worked in October, not in November.

Fix: pin the boundary in the test's seed state.
- In `scripts/check-sqlite.mjs`, find the first seed block: line 21 `await repository.mutate(state => {`.
- Add `state.budgetHistoryUnavailableBefore='2026-01';` as the first statement inside that callback.
- Do not change any assertion.

If other assertions break after that (they would show different values), stop and read `worker/index.js` lines 415-440 (`budgetHistoryUnavailableBefore` use) before changing anything else; report instead of guessing.

Verify: `bash scripts/run-node.sh scripts/check-sqlite.mjs` passes.

### WP1.3 `scripts/measure-performance.mjs` (line ~147)

Cause: the `goal` route now requires an owner profile. Error: `Choose Peter, Maddie, or Joint for this savings goal.`

Fix:
- Line 75 (seed): add `profileId: 'peter'` to the `goal-emergency` object in `state.goals`.
- Line 147 (`goal_edit` payload): add `profileId: 'peter'`.
- If another route then returns a 400 about ownership, add `profileId: 'peter'` to that seed/payload the same way (one at a time, rerun after each).

Verify: `bash scripts/run-node.sh scripts/measure-performance.mjs 10000` completes and prints results. (This is the `extended` profile and is not part of `test:ci`; it only needs to run without error.)

### WP1.4 Browser cases depend on the date

Cause for `sample-transaction-filters`: sample data (`ui/browser.js` line 30) only includes sample rows whose day-of-month is `<=` today's day, so on Nov 1 there are 2 rows, but the case (`scripts/browser-cases.mjs` line 127) waits for exactly 22 rows. The case only passes on or after the 25th.

Cause for `form-drafts` (fails at `browser-cases.mjs` line 644 waiting for an option in `#month`): same family of problem; it computes months from "now" and the option it needs does not exist on the 1st. Retained artifacts: `failure.png` shows the page on September 2026.

Fix (test-only, apply to both): freeze the browser clock to the 28th of the current Chicago month so every sample row exists and "current month" is stable.
- In `scripts/browser-cases.mjs`, the context is created at line 66 (`context = await browser.newContext(...)`). Directly after `page = await context.newPage();` (line 67) add:
```js
if (['sample-transaction-filters', 'form-drafts'].includes(name)) { await context.clock.setFixedTime(new Date(monthInChicago() + '-28T18:00:00Z')); }
```
- `monthInChicago()` is defined at line 13 of the same file and returns `YYYY-MM`.
- If `context.clock` is undefined, the installed Playwright is too old; check `node_modules/@playwright/test/package.json` (pinned 1.64.1 supports it). Then use `await context.addInitScript` to override `Date` instead and tell Peter.

Verify, one at a time:
```
BROWSER_CASE=sample-transaction-filters npm run check:browser:case
BROWSER_CASE=form-drafts npm run check:browser:case
```
If `form-drafts` still fails, open the newest `failure-case-*/failure.png` and `failure.txt` under `$TMPDIR/ledger-test-profile-*/ledger-browser-failures/`. The screenshot shows the app state when it timed out. Report what is on screen; do not weaken assertions. Never delete or loosen an assertion to make a case pass.

### WP1.5 Full run

```
npm run test:fast && npm run test:integration && npm run test:recovery && npm run test:browser && npm run test:release
```
Acceptance: every profile prints `"status": "PASS"`. Note in the PR description that dates were not varied (no `faketime` on this machine); the clock freeze covers the browser cases only.

## WP2. Make a wrong bill match fixable

Problem (reproduced with a synthetic script): after matching payment A to a bill's due date, matching payment B returns 409 `This payment or commitment date is already matched. Review the existing match first.` There is no UI to review or remove a match. If a provider later changes the payment amount, the match shows "needs review", and the same 409 blocks re-matching.

Design: add an `unlink` action (soft-delete, audit trail kept), the same way reimbursements do it (`worker/index.js` lines 592-602 for the pattern). After unlinking, the normal "Link bill" flow works again.

### WP2.1 Server: `worker/index.js`, route `POST /api/commitment-match` (line ~614)

Matches have no id. Identify them by `commitmentId` + `dueDate`.

1. At the top of the handler, after the `replay` line, add an unlink branch before the `commitment` lookup:
```js
if(input.action==='unlink'){
  if(input.confirmed!==true||typeof input.commitmentId!=='string'||typeof input.dueDate!=='string')throw apiError('Confirm the payment link to remove.');
  const mutation=await mutateWithReplay(env,'commitment-match',input,s=>{checkRevision(s,input);const link=(s.commitmentMatches||[]).find(row=>row.commitmentId===input.commitmentId&&row.dueDate===input.dueDate&&row.status==='user-confirmed');if(!link)throw apiError('Active payment link not found.',404);link.status='unlinked';link.unlinkedAt=new Date().toISOString();s.owner=user;},(s,revision)=>({ok:true,revision,unlinked:{commitmentId:input.commitmentId,dueDate:input.dueDate}}),null,'owner');
  return response(mutation.result);
}
```
2. In the existing duplicate check inside the match mutation, only count active matches. Change
`s.commitmentMatches.some(row=>row.commitmentId===match.commitmentId&&row.dueDate===match.dueDate||row.transactionId===match.transactionId)`
to
`s.commitmentMatches.some(row=>row.status==='user-confirmed'&&(row.commitmentId===match.commitmentId&&row.dueDate===match.dueDate||row.transactionId===match.transactionId))`
3. Two other places read `state.commitmentMatches` and must ignore unlinked rows: `worker/index.js` line 96 (`for(const match of state.commitmentMatches||[])`) and line 110 (`.filter(row=>row.commitmentId===commitment.id)`). Add `&&row.status==='user-confirmed'` (or `if(match.status!=='user-confirmed')continue;` for the `for` loop). Also run `grep -n "commitmentMatches" worker/index.js shared/*.mjs server/*.mjs` and handle any other reader the same way.
4. `shared/commitments.mjs` line 23 already filters `status==='user-confirmed'`, so unlinked matches no longer count as paid. Do not change it.

### WP2.2 UI: Commitments page (`ui/browser.js` line 190, function that builds `dateRows`)

1. In the row template (`'<div class="budget-label commitment-date-row">...`) append, for rows whose `status` is `user-confirmed` or `needs-review`, a button:
`<button class="btn text" type="button" data-unlink-commitment="'+esc(row.commitmentId)+'" data-due-date="'+esc(row.dueDate)+'">Unlink payment</button>`
   Hide it when `demo` is true.
2. If `row.observedAmount!==undefined&&row.observedAmount!==row.amount`, show the paid amount separately: change the visible amount to `'Paid '+money(row.observedAmount)+' · bill now '+money(row.amount)`. (Do not change the forecast status; editing a bill's amount going forward must not flip past months to "needs review".)
3. In `bind()` (line ~294), next to the `[data-link-commitment]` handler, add a handler for `[data-unlink-commitment]` that: asks to confirm (use `confirm(...)` now; WP6 converts it later) with message `Unlink this payment from the bill? The payment stays in your transactions.`; calls `api('commitment-match',{action:'unlink',commitmentId,dueDate,confirmed:true,revision:writeRevision()})`; then `noteMutation(result); await refresh(); toast('Payment unlinked.');` and on error `toast(error.message)` (copy the `data-undo-account-owner` handler on line 294 as the pattern, including `button.disabled`).
4. Make the row's status text plain English: `User-confirmed payment` -> `Paid`, `Match needs review` -> `Check this payment`, `Expected` -> `Due`.

### WP2.3 Tests

Add to the API half of `scripts/check-commitments.mjs` (after the `matched` lines, before `calendar`), using the existing `request(...)` helper and `state`:
- Match payment A. Unlink it (`action:'unlink'`, `confirmed:true`). Expect 200. Calendar for that month shows the date as `expected`.
- Unlink again -> 404. Unlink with `confirmed:false` -> 400.
- Match payment B for the same due date -> 200 (this used to be 409).
- `matches` in the calendar response may still contain the unlinked row; assert only that `forecast[0].status` is `user-confirmed` with `transactionId` of B.
Add to the browser case `transaction-splits-commitments` (find with `grep -n "transaction-splits-commitments" scripts/browser-cases.mjs`): after a bill is matched, click `Unlink payment`, accept, and assert the row reads `Due`.

Verify: `bash scripts/run-node.sh scripts/check-commitments.mjs`, then `BROWSER_CASE=transaction-splits-commitments npm run check:browser:case`.

Acceptance: a user can link a payment to a bill, unlink it, and link a different payment, with no 409.

## WP3. Add a transaction by hand

Problem: no route or screen creates a transaction (confirmed by listing every POST route in `worker/index.js`). Without Plaid, Maddie must download and map a bank CSV for every update. A person who is not technical needs "I just bought coffee, add it."

### WP3.1 Server: new routes in `worker/index.js`

Place both routes immediately before `if(path==='/api/import-undo'&&request.method==='POST')`. Use the `/api/import` route (lines ~806-826) as the template for structure: `body(request)`, `findOperationReplay`, `checkRevision`, `mutateWithReplay(env,scope,input,update,buildResult,transactionIds)`. Read `mutateWithReplay` (line 178) and `prepareCsvImport` first (`grep -n "function prepareCsvImport" worker/index.js`) and **copy the exact transaction object shape** that import produces (fields like `categoryId`, `currency`, `pending`). Do not invent fields.

**`POST /api/transaction-add`** input: `{accountId, date, merchant, amount, direction, category, revision, clientOperationId}`
- `amount` = positive integer cents (the UI converts dollars). `direction` = `'spent'` or `'received'`.
- Validation (each throws `apiError(<plain message>)`, status 400):
  - account exists, is not archived, and is manual or CSV (`manual` true or `source` `'csv'`); provider accounts are rejected with `Add transactions to accounts you track by hand. Bank-connected accounts fill in automatically.`
  - `date` passes `validDateOnly`, is not after today (`dateInReportingZone()` exists in this file), and is not before `2000-01-01`.
  - `merchant` is a non-empty trimmed string of at most 100 chars.
  - `amount` is a safe integer from 1 to 100_000_000_000.
  - `category` is one of the names returned by `categories(state)` (see how `/api/category` validates; reuse that helper). If `direction==='received'` and no category, use `Income`.
- Stored sign follows the app convention: spending is a positive `amount`, income is negative. `received` -> `-amount`.
- New transaction: `id: 'manual-'+crypto.randomUUID()`, `itemId: null`, `accountId`, `date`, `merchant`, `amount`, `category`, `pending:false`, `currency:'USD'`, `source:'manual'` plus whatever import adds. The profile is inherited from the account (do not store `profileId` on the transaction).
- Run it through `mutateWithReplay(env,'transaction-add',input,s=>{checkRevision(s,input);s.transactions.push(tx);s.owner=user;},(s,revision)=>({ok:true,revision,transaction:tx}),[tx.id])`. The id array is the 6th argument, the same as import passes `plannedIds`.

**`POST /api/transaction-remove`** input: `{id, confirmed:true, revision, clientOperationId}`
- Only transactions with `source==='manual'`. Anything else -> 400 `Only transactions you added by hand can be removed.`
- Refuse (409, plain message) if the transaction has a split (`transactionSplits`), a reimbursement link, or an active commitment match. Look up the state keys with `grep -n "transactionSplits\|transactionReimbursements\|commitmentMatches" worker/index.js`.
- Remove with `mutateWithReplay` and the same transaction-id argument.

### WP3.2 UI: `ui/browser.js`

1. Add an `Add transaction` button next to `Import CSV` on the Transactions page header (find with `grep -n "Import transactions CSV\|id=\"import\"" ui/browser.js`). Hidden or disabled with a tooltip text in sample mode.
2. New function `addTransactionDialog()` placed next to `manualAccountDialog` (line ~299). Copy that function's structure: `document.createElement('dialog')`, `dialog.innerHTML=<form>`, `showDialog`, `runDialogSubmit`, `api(...)`, `noteMutation`, `await refresh()`, `toast(...)`.
   Fields, in this order, with plain labels:
   - Radio: `Money spent` (default) / `Money received`
   - `Account` select (manual and CSV accounts only). If none, replace the form body with: `Add an account first, then come back.` and a button that opens `manualAccountDialog()`.
   - `Date` (`type=date`, default today via the existing `reportingDate()`, `max` = today)
   - `What was it for?` (`name="merchant"`, `maxlength=100`, required)
   - `Amount` (`inputmode=decimal`, placeholder `0.00`, required)
   - `Category` select (default `Other`; hidden when "Money received")
   - Submit `Save` and `Cancel` (id must start with `cancel-` so `ui/dialogs.mjs` dirty-form handling applies).
3. Convert amount text to cents with a strict regex, not float math: accept `/^\d{1,9}(\.\d{1,2})?$/` after removing a leading `$` and commas; otherwise show `Enter an amount like 12.50.` in the dialog's `role="alert"` element. Cents = `Number(whole)*100+Number(fraction.padEnd(2,'0'))`.
4. After a save, show toast `Added “<merchant>” for <money>.`
5. In the transaction row actions (the code that renders `Link bill` / `Link reimbursement`, search `data-link-commitment`), add `Remove` for rows where `t.source==='manual'`, wired to `transaction-remove` with the same confirm pattern.
6. On mobile the dialog must fit in 390x844 with no horizontal scroll; check with a screenshot (see Verify).

### WP3.3 Tests

- New file `scripts/check-manual-transactions.mjs` modelled on the API half of `scripts/check-commitments.mjs` (mock repository, `request()` helper, `worker.fetch`). Cases: success spent; success received (negative amount, category `Income`); provider account rejected; future date rejected; empty merchant; amount `0` rejected; amount with float `12.5` handled by UI only (API rejects non-integer); replay with same `clientOperationId` does not duplicate; stale revision -> 409; remove manual -> 200; remove CSV-imported -> 400; remove one with a commitment match -> 409; totals: after adding a 1250 spend, `totals()` (from `shared/reporting.mjs`) spend increases by exactly 1250.
- Register it: add `scripts/check-manual-transactions.mjs` to the `fast` array in `scripts/run-test-profile.mjs` (line 16) and add an npm script `"check:manual-transactions"` in `package.json` next to `check:commitments`.
- New browser case `manual-transaction`: add the name to `availableBrowserCases` (`scripts/browser-cases.mjs` line 11) and to `peterCases` (line 88). Steps: add a manual account, open Add transaction, enter `Coffee`/`4.75`/`Dining`, save, see the row with `$4.75`, reload, row persists, remove it, row gone. Add 390x844 viewport screenshot assertion `document.documentElement.scrollWidth <= innerWidth+1`.
- Also assert in the main `scripts/check-browser.mjs` sample-mode section that `Add transaction` is not usable in sample mode (no POST).

Verify: `bash scripts/run-node.sh scripts/check-manual-transactions.mjs`, `BROWSER_CASE=manual-transaction npm run check:browser:case`.

Acceptance: from the Transactions page, a user adds a purchase in under 30 seconds and can remove it; totals, budgets, and the Overview update.

## WP4. Plain-language pass

Principle: lead with the answer, keep the explanation one click away, and never show system words to the user. Rule for every string: **change visible text only; never change `data-` attributes, ids, class names, API paths, or `aria-label`s that tests select on** unless you update those tests in the same step (use rule 7).

### Glossary (apply everywhere visible)

| Say this | Not this |
|---|---|
| category | bucket (visible text only; keep the code/API word `bucket`) |
| spent so far | actual spent / posted spending |
| left to spend | left in bucket / remaining allowance |
| income remaining | income left after |
| bank connection | provider connection / Plaid |
| bills | commitments (nav label and page title only) |
| set aside | budgeted as |

For "commitments" -> "Bills": the nav label (`Commitments` in the sidebar and `#mobile-page-select`), the page `<h2>`, and the `Commitments` button on the Budgets page (line 177). Keep `data-view="commitments"` and the `?page=commitments` URL unchanged. Tests select `[data-view="commitments"]`, which stays valid. Update tests that match the visible text.

### Strings to change (find with grep -F, then edit)

1. **Budgets header copy** (line 177): `Plan take-home income, spending, and savings. Unspent bucket balances carry forward; overspending carries as a negative balance.` -> `Decide how much to set aside for each category. Money you do not spend rolls over to next month. If you overspend, it comes out of next month.`
2. **Budgets column headers** (same line): `Bucket`->`Category`, `Plan / edit`->`Plan`, `Planned`->`Planned`, `Actual spent`->`Spent so far`, `Left in bucket`->`Left to spend`, `Income left after`->`Income remaining`, `Planned buckets / result`->`Total planned`.
3. **Add one answer line at the top of the Budgets page**, above `.budget-income-summary`: a `<p class="budget-answer">` using `projection.bucketRemaining` (same value shown in the total row): if `>= 0` -> `You have <b>$X</b> left to spend this month across your planned categories.`; if `< 0` -> `You are <b>$X</b> over your plan this month.` Use `money()`; handle the unknown case by omitting the line. Style: reuse an existing text class; add at most a few lines to `ui/styles.css`.
4. **Wrap the explanation** (`<section class="budget-confidence">`, heading `What this estimate includes`) in a `<details>` with `<summary>How we worked this out</summary>`, closed by default. Keep its paragraphs. Rewrite these sentences: `Recorded USD account balances: unknown.` -> `Account balances: not entered yet.`; `User review is not recorded as financial completeness.` -> delete; `Weekly plans are budgeted as 4 weeks per month.` -> `Weekly amounts are counted as 4 weeks per month.`; `Posted USD spending` -> `Spending so far (pending charges not included)`.
5. **Overview** (lines 108, 123, 125): `Posted USD spending and effective category budgets` -> `Spending and budgets, month to month`; `Posted income this month` -> `Income received this month`; `Income less spending` -> `What came in minus what went out`; `Across budgeted categories` -> `Left across your planned categories`; `2026-11 spending` style labels -> use the month name (`November spending`, `October budget`, via `toLocaleDateString('en-US',{month:'long'})`).
6. **Overview balance sheet** (line 106): `Balance sheet` -> `Your accounts at a glance`; `Record today’s snapshot` -> `Save today’s balances`; `Net worth · recorded USD records` -> `Net worth (from the accounts you have entered)`. Explain "snapshot" once in a `card-sub`: `Saving balances builds a history so you can see how they change over time.`
7. **Accounts empty state** (lines 199 and 298): `Provider connections are not configured` + `Add Plaid credentials to the private configuration on your Jetson ...` -> title `Bank connections are turned off`, text `You can still add accounts yourself or import a file. Ask Peter if you would like banks connected.` Move the Plaid/Jetson/config wording into Settings only, in the Advanced section (WP4 item 8).
8. **Settings** (line 249, `settingsPage`): add a first card, `Everything looks fine` / `Needs attention`, with plain lines: `Backups: last saved <relative time>` (or `No backup has run yet`), `Bank updates: on / off`. Choose "Needs attention" if `backup.recoveryStale` or `backup.state==='failed'`. Put the existing cards (`Sync timer`, `Latest sync job`, `Local recovery backups`) inside `<details><summary>Technical details</summary>`. Existing browser assertions match `Sync timer ... bank data sync timer` and `Backup timer ... Next backup run`; those texts still exist inside `<details>`, but Playwright `innerText` skips closed details, so update that assertion in `scripts/check-browser.mjs` line 55 to open the details first (`page.locator('details:has-text("Technical details") summary').click()`).
9. **Empty/loading** (line 266): `Loading your private records…` -> `Loading your records…`.
10. **Link buttons** on transaction rows: `Link bill` stays; `Link reimbursement` -> `Link a refund from someone`.
11. **Import dialog**: find the column-mapping labels with `grep -n "Spending sign\|sign convention\|ISO" ui/browser.js` and add a one-line help text under each (`Date format: pick how dates look in your file, for example 03/14/2026 is US.`; `Amounts: choose whether purchases are positive or negative in your file.`). Keep the controls.

After each numbered item: `npm run build`, grep the tests for the old text, fix, run `npm run test:browser`.

Acceptance (Peter reads each page aloud): no sentence on Overview, Transactions, Budgets, Bills, Accounts contains any of: `bucket`, `Posted`, `USD` (except in amounts), `Plaid`, `Jetson`, `provider`, `commitment`, `snapshot` without explanation, `user review`. Grep check:
`grep -n -i "bucket\|Posted USD\|Plaid credentials\|Jetson" ui/browser.js | grep -v "data-\|id=\|class=" ` and review remaining hits by hand.

## WP5. First-run guide

Replace the empty Overview card (`grep -n -F "Start with your real finances" ui/browser.js`, line 250) with a three-step checklist. Show it on Overview when not in sample mode and any step is incomplete; hide it once all are done.

Steps (done-state from existing data fields):
1. `Add your accounts` — done when `data.accounts.length>0`. Button opens `manualAccountDialog()` (WP3's "add an account first" link uses the same).
2. `Add your spending` — done when `data.transactionCount>0`. Buttons: `Add a transaction` (WP3) and `Import a file` (existing import dialog).
3. `Set a monthly plan` — done when `data.budgetTemplates?.length>0`. Button goes to `?page=budgets`.

Markup: an ordered list; each step has a number, a title, one sentence (`Checking, savings, and credit cards. You can type the balance in yourself.`), a done checkmark (text `Done`, not color alone), and a primary button only on the first incomplete step. Keep `Explore sample data` as a text button below the list.

Also: when the Overview has zero accounts, do not show `Net worth ... $0.00`; show `Add an account to see this`.

Tests: update `scripts/check-browser.mjs` and `scripts/browser-cases.mjs` places that read `Start with your real finances` (grep). Add one assertion that step 1 shows `Add your accounts` and its button opens a dialog; after adding an account, step 1 shows `Done` and step 2's button is primary.

Acceptance: a brand-new database shows the checklist; a person can reach "first transaction saved" in the order shown without leaving the Overview.

## WP6. Replace native `confirm()` pop-ups

Why: native browser pop-ups look broken in a money app and cannot be styled or explained. Do this only after WP1-WP5 pass, because it touches many tests.

### WP6.1 Helper: `ui/dialogs.mjs`

Export `askConfirm({title, message, confirmLabel, cancelLabel, danger})` returning `Promise<boolean>`:
- Build a `<dialog class="confirm-dialog" role="alertdialog" aria-labelledby aria-describedby>` containing `<h2>`, `<p data-confirm-message>`, and two buttons: `data-confirm-cancel` and `data-confirm-ok` (`danger` adds a class for destructive actions).
- **Set `title`, `message`, and labels with `textContent`, never `innerHTML`** (messages can contain user-entered names).
- Default `title`: `Please confirm`; default labels `Confirm` / `Cancel`; focus `data-confirm-cancel` first for destructive actions, `data-confirm-ok` otherwise.
- Resolve `false` on Esc (`cancel` event), backdrop click, or the Cancel button; `true` on OK. Remove the dialog and return focus to the previously focused element. Do not use `showDialog` (it adds the "unsaved changes" behavior).
- Add `.confirm-dialog` styles in `ui/styles.css`, reusing the existing dialog styles; width `min(92vw, 28rem)`; buttons at least 44px tall.

### WP6.2 Convert callers

The 22 native `confirm(` calls in `ui/browser.js` plus 2 in `ui/dialogs.mjs`. List them: `grep -n "confirm(" ui/browser.js ui/dialogs.mjs`. For each: `if(!confirm(msg))return;` -> `if(!await askConfirm({message:msg}))return;` and make the enclosing function `async` if it is not. **Keep the message text identical** so test regexes still match. Import `askConfirm` at the top of `ui/browser.js` from `./dialogs.mjs` (see how `showDialog` is imported).

Special cases:
- `ui/dialogs.mjs` `showDialog` (lines 15 and 22, "Discard your unsaved changes?"). For the `cancel` (Esc) handler: always `event.preventDefault()`; if dirty, `askConfirm(...).then(ok=>{if(ok)closeDialog(dialog);})`, else close. For the capture click handler: if dirty and `dialog.dataset.discardConfirmed!=='true'`, call `event.preventDefault();event.stopImmediatePropagation();` then `askConfirm(...).then(ok=>{if(ok){dialog.dataset.discardConfirmed='true';closeControl.click();dialog.dataset.discardConfirmed='';}})`. Skip the dirty check when `discardConfirmed==='true'`.
- `confirmProfileNavigation` (`ui/browser.js` line 63) is synchronous and its return value gates navigation. Convert its callers to `await` it, or leave this single one native if more than three call sites need restructuring, and say so in the PR description.

### WP6.3 Tests

`scripts/check-browser.mjs` has 23 uses of `withDialog` and `page.on('dialog')`; `scripts/browser-cases.mjs` has 1. Rewrite `withDialog(pattern, action, trigger)` (defined at `check-browser.mjs` line 36) so it: runs `trigger()` without awaiting, waits for `dialog.confirm-dialog`, asserts its text matches `pattern`, clicks `[data-confirm-ok]` for `'accept'` or `[data-confirm-cancel]` for `'dismiss'`, then awaits the trigger. **Keep the existing `page.on('dialog')` listener** that logs unexpected native dialogs; it becomes a regression guard that a native `confirm` never appears. Add one assertion at the end of the broad run that no unexpected native dialog was logged.

Do conversion in groups of 3-5 callers, rebuild, run `npm run test:browser` after each group.

Acceptance: `grep -c "confirm(" ui/browser.js` shows only `askConfirm(` hits (plus the documented exception, if any), and `npm run test:browser` passes.

## WP7. Small fixes

1. **Plural bug**: `1 purchases` (`ui/browser.js` lines 123 and 125). Add helper `const plural=(n,one,many=one+'s')=>n+' '+(n===1?one:many);` near the other small helpers at the top of the main function, and use `plural(purchases,'purchase')` / `plural(summary.purchases,'purchase')`. Keep the `<span class="accent">` wrapper on the number phrase.
2. **Import preview plural**: `1 rows · 1 account(s)` and `Commit 1 rows` (asserted in `scripts/check-browser.mjs` lines 112, 113, 123, 127 and probably in `browser-cases.mjs`). Use the same helper: `1 row · 1 account`, `Commit 1 row`, `2 rows · 1 account`. Update the tests in the same step (rule 7).
3. **Sample date uses UTC** (`ui/browser.js` line 30): `new Date().getUTCDate()` -> the Chicago day. Use the existing `reportingDate()` helper: `Number(reportingDate().slice(8,10))`. Confirm `reportingDate` is in scope at that line (`grep -n "function reportingDate\|const reportingDate" ui/browser.js`).
4. **Sample preview looks empty early in the month** (2 rows on the 1st): in sample mode for the *current* month, show all sample rows dated up to the 25th regardless of today, because they are synthetic and clearly labelled. Then remove the WP1.4 clock freeze for `sample-transaction-filters` if the case passes without it. Only do this item if Peter agrees: it changes the sample-data contract that `sample-isolation` and the filter cases depend on.
5. **Detector finding**: `Inter` font (`ui/styles.css` line 1) is flagged as common. No action; note only.

## WP8. Later (do not start without Peter)

- Default the profile selector to the signed-in person. Needs the server to expose the actor ID (`tailscaleMembers` -> `actorId`) in `/api/state`, then `ui/browser.js` selects it on first load. This keeps Maddie's first screen personal.
- Replace the mobile nav `<select>` (`#mobile-page-select`) with a bottom tab bar (Overview, Transactions, Budgets, More).
- Hide advanced pages (Investments, Home planner) behind "More".
- Screen-reader and physical 200% zoom checks (documented as not done in README).
- Real Plaid connection, if wanted.

## WP9. Acceptance: the Maddie trial

Run this with Maddie after WP0-WP7, on her phone, through Tailscale. Peter sits beside her, says nothing, and writes down every pause longer than 5 seconds and every question.

Tasks (each should take under 2 minutes without help):
1. Open the app from the Home Screen icon.
2. Add the checking account with today's balance.
3. Add a purchase she made yesterday.
4. Say, by reading the Budgets page, how much is left for groceries this month.
5. Change the category of a transaction.
6. Fix a mistake: remove the purchase from step 3.
7. Say what "Overview" is showing and whether the numbers look right.
8. Find where to check whether backups are working (she should reach Settings and read the summary card).

Pass criteria: 8 of 8 completed alone; no task needs more than one retry; she asks what a word means at most once in total. Write fixes for any miss into a follow-up list; then repeat only the failed tasks.

## WP10. Release (Peter does this)

After WP1-WP7 pass `npm run test:ci`:
1. Update the `Current production release` paragraph in `README.md` after activation, not before.
2. Follow the README's `Jetson service` section: `scripts/prepare-release.sh "$(git rev-parse --short=12 HEAD)"` then `scripts/activate-release.sh ...`, with a fresh recovery bundle created first (`docs/LOCAL_BACKUP_RECOVERY.md`).
3. Check `/api/health`. If anything looks wrong, run `scripts/rollback-release.sh` (see the README rollback paragraph). A rollback of code is safe; the schema is not changed by this plan.

This plan adds no database migration. If any step seems to need one, stop and ask Peter.

## Verification matrix

| After | Run | Expect |
|---|---|---|
| WP1.1 | `bash scripts/run-node.sh scripts/check-finance.mjs` | no error |
| WP1.2 | `bash scripts/run-node.sh scripts/check-sqlite.mjs` | no error |
| WP1.3 | `bash scripts/run-node.sh scripts/measure-performance.mjs 10000` | prints results |
| WP1.4 | the two `BROWSER_CASE=` commands | both pass |
| WP1.5 | `npm run test:ci` | all PASS |
| WP2 | `check-commitments.mjs`, then `BROWSER_CASE=transaction-splits-commitments` | pass |
| WP3 | `check-manual-transactions.mjs`, then `BROWSER_CASE=manual-transaction` | pass |
| WP4-5 | `npm run test:browser` | pass; grep acceptance in WP4 |
| WP6 | `npm run test:browser` after each group | pass |
| WP7 | `npm run test:browser` | pass |
| End | `npm run test:ci` and `npm audit --omit=dev` | all PASS, 0 vulnerabilities |

Rendered check for every UI WP (WP2-WP5): start a synthetic server the same way `scripts/check-browser.mjs` lines 15-19 do (temp data dir, config `{"storageMode":"sqlite","enablePlaid":false}`, own `PORT`), take screenshots at 1440x900 and 390x844 with Playwright (`node_modules/@playwright/test`), and look at them. Confirm no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth+1`), no clipped buttons, and no technical wording. Stop the server afterwards.

## Order and size

| WP | Depends on | Size | Risk |
|---|---|---|---|
| WP1 | none | small | low |
| WP2 | WP1 | small-medium | low |
| WP3 | WP1 | medium-large | medium (new write path) |
| WP4 | WP1 | medium | medium (many test strings) |
| WP5 | WP3 | small | low |
| WP6 | WP1-5 | large | medium (many test edits) |
| WP7 | WP1 | small | low |
| WP9 | WP0-7 | human | none |

If an instruction here conflicts with the code you find, stop and write down what you found and which step is affected. Do not guess, and do not weaken or delete a test to get past it.
