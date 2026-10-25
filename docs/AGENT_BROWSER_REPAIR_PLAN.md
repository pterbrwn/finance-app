# Ledger repair and acceptance plan after agent-browser review

Baseline: commit `43fccbd`. Evidence: `/tmp/ledger-agent-browser.aTjTGT/report/report.md` and its screenshots. The review used a fresh synthetic SQLite copy; it did not change this checkout or the owner's preview.

## Execution status

The implementation and automated repair gates described below have now been completed in the working tree. Final disposable-source checks passed under Node 24.22.1, and final agent-browser evidence is in `/tmp/ledger-repair-final-20261025/report/`. Remaining browser gaps and owner-only acceptance are listed in R06 of `docs/IMPLEMENTATION_PROGRESS.md`; this does not complete C10 or authorize deployment/storage migration.

The next implementer should complete the work below in order. Use pinned Node `24.22.1`, a fresh source copy, a private disposable data directory, `{"storageMode":"sqlite","enablePlaid":false}`, and a loopback `PORT=0` server for browser checks. Leave the running owner preview and private financial records alone. Keep a short result log that distinguishes a confirmed defect, a passing check, and an unverified flow.

## 1. Restore archived custom categories

**Confirmed:** Two archived custom categories remained visible in the manager with no Restore action.

- In `worker/index.js`, extend `/api/category-update` with `action:'restore'`. Clear `archivedAt` on the existing category record. Keep its ID, name, order, budget templates, overrides, and transaction assignments. Require the observed revision, reject invalid/system category requests, and return the new revision. Handle repeated archive/restore requests deliberately rather than silently changing the archive timestamp or revision.
- In `ui/browser.js`, render a Restore button beside an archived custom category. Bind it to the API and implement the same behavior in explicit sample mode. Preserve a visible status message and keyboard focus after the manager rerenders. Keep archived categories unavailable for *new* transaction assignments until restored.
- Add focused API and browser regressions in `scripts/check-finance.mjs` and `scripts/check-browser.mjs`: create → archive → restore, two distinct categories, same ID and historical transactions throughout, budget history preserved, stale revision rejected, and restored category available to new assignments. Check a reload between archive and restore.

**Done when:** An archived category has a working Restore control, survives reload, and returns to the active budget and assignment choices without changing historical records.

## 2. Filter and export historical transactions in archived categories

**Confirmed:** The filter at `ui/browser.js` `transactions()` uses `activeCategories()`; an archived category disappears. A direct `?page=transactions&category=Archive%20Journey` URL leaves the control at All categories. The transaction still displays its archived category.

- Build transaction **filter** options from the full catalog, with an “archived” label and a selected option for a valid archived category. Continue to use active categories for transaction edit, bulk assignment, and CSV import mapping. Preserve existing URL and back/forward behavior.
- Keep the transaction query and CSV export scoped to the same effective category. The shared matcher and the JSON/SQLite query paths already handle effective overrides; check them before changing query semantics. Preserve stable category identity through rename and archive, and handle a direct archived-category URL after reload.
- Extend the browser regression to cover filtering before and after archive, a direct URL, search/month/account filters, pagination, and downloaded CSV after a transaction is recategorized. Cover both a row with a category ID and a legacy label-only row in `scripts/check-finance.mjs`/`scripts/check-sqlite.mjs` where needed. Reproduce the reported filter failure with two archived categories before calling it closed.

**Done when:** Archived historical categories remain selectable for filtering, their scoped CSV contains the matching effective-category rows, and no archived category is offered for a new assignment.

## 3. Complete the scenario form and action journey

**Unverified in the agent-browser run:** The complete save, saved-versus-preview result, comparison, and goal/budget actions. The required closing-cost inputs sit inside a collapsed `<details>` section of a scrollable dialog. The browser suite currently opens every section before filling them (`scripts/check-browser.mjs`); that bypasses the blank-form discovery path.

- Reproduce at 1280×577 with keyboard and pointer. Submit the scenario with purchase/loan and ownership fields filled while the closing section stays collapsed. Check whether native validation identifies and reveals the first missing required cost, announces an understandable error, and moves focus to a visible control.
- If validation leaves the user stuck or silent, update `scenarioDialog()` in `ui/browser.js` so invalid controls open their ancestor `<details>` section and receive visible focus and a meaningful alert. Mark sections containing required fields clearly. Preserve entered values on validation errors.
- Extend the existing scenario browser path to enter explicit zero costs through the normal UI, compare the live preview with the saved result, reopen/edit the saved version, compare two scenarios, and exercise the separate confirmed goal and Housing-budget actions. Verify those actions change only the intended goal/budget after confirmation. Check unsupported mortgage projections separately so no fabricated schedule is shown.
- Add calculator/API assertions only where a newly found logic error requires them; existing scenario math coverage is extensive. Record any remaining browser-tool limitation as unverified rather than a product defect.

**Done when:** A user can discover every required cost, finish the scenario with keyboard or pointer, see matching preview/saved values, compare saved scenarios, and deliberately apply a goal or budget action.

## 4. Preserve drafts and focus across request failures

**Source-identified risk, not browser-confirmed:** Some category and budget handlers in `ui/browser.js` call `render()` before their POST completes, then rerender after an error or 409. That can replace an edited input with the last saved value. `api()` also assumes every failed response has JSON.

- Use browser request interception on the disposable server to force an offline/aborted request, a 500 response, and a stale-revision 409 during category rename, budget template/month override, manual account edit, and scenario save. Record the input value, selected text/caret where relevant, active element, announced error, and revision before/after.
- Fix confirmed losses at the handler level: retain a draft until success, keep the relevant form/dialog open on failure, show a persistent inline `role="alert"`/status message, and return focus to the field or action. For 409, refresh authoritative state without silently overwriting the unsaved draft; make retry or cancel clear. Make `api()` report network, non-JSON, and server failures consistently.
- Add only targeted browser checks for the failure modes that reproduce. Ensure retries do not duplicate writes and successful saves use the latest revision.

**Done when:** A failed or stale request leaves the typed value and an obvious retry path, and focus and error text remain usable.

## 5. Close the remaining synthetic browser gaps

These are **checks first**. Change product code only for a reproduced break, then add a focused regression.

- Budget template edits, monthly override/explicit zero/reset, and switching months after reload.
- Manual investment and liability accounts, account archive/restore, balance-sheet totals, and goal-funding display. Confirm eligible cash is not inflated by investments or liabilities and archived/excluded accounts follow the documented rules.
- Mortgage record variants, statement balance versus projection, unsupported loan types, and loan archive/restore.
- Backup and sync status in disabled and failed states. Exercise stale revisions and failed/offline requests with draft/focus preservation; do not run a real provider sync.
- Keyboard-only navigation through the main flows; initial/returned dialog focus and Escape; visible errors; long names; chart text/data alternatives; 390 and 320 px layouts. Check actual browser 200% zoom in a browser that exposes it. A 720 px CSS viewport is a useful proxy but does not establish actual zoom behavior.
- Continue checking agent-browser `errors` and `console` during the journey; capture exact steps, expected and observed result, viewport, screenshot, and relevant console output for each new defect. Reproduce each suspected defect twice before adding it to the defect list.

Use `agent-browser skills get core --full` and `agent-browser skills get dogfood` before the next agent-browser pass. Use a named session, a fresh `snapshot -i` after each UI change, and close the browser and synthetic server at the end.

## 6. Verify and hand off

- Run focused regressions while implementing. Once the fixes are integrated, run `npm run check`, `npm run check:local-http`, and `npm run check:browser` under pinned Node `24.22.1` in a fresh disposable source copy. Inspect `git diff --check` and the final patch. Do not infer manual acceptance from green automation.
- Update `docs/IMPLEMENTATION_PROGRESS.md` with the fixed defects, browser evidence, and remaining unverified flows. Keep the screenshot/report artifacts under a disposable directory and link to them in the handoff.
- Keep C10 owner desktop screen-reader and actual zoom/private-access review open until the owner records it. C12–C14 private migration, recovery, proxy, and activation gates remain separate; this plan does not authorize deploying the branch or changing the live storage mode.

Execution order matters: fix the two confirmed category defects, investigate the scenario form, then address failures discovered by the remaining browser checks. Report unverified items plainly if the headless environment cannot exercise them.
