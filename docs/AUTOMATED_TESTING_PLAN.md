# Ledger automated testing execution plan

Prepared 2026-10-26 from checkout `adb0ba4`. **Planning only; the tasks below are not implemented or verified by this document.** This is the current testing handoff, paired with [the browser playbook](AGENT_BROWSER_REPAIR_PLAN.md). Read the latest progress entry before executing: R06 records prior repairs; R07 records subsequent private activation. Do not restart the completed repair work or infer current service state from an older plan.

Owner report: “changing all transactions didn't fully save,” after which the owner stopped testing. This is a P1 save-integrity acceptance blocker, recorded as reported rather than browser-reproduced. Do not ask the owner to perform more QA. Investigate both rapid individual category edits and bulk categorization: the exact interaction is not yet known. Run B01/B02 first after the minimum safe harness setup; verify every intended record after reload and a synthetic server restart before declaring the report resolved.

The separately planned [budget plan-versus-actual update](BUDGET_PLAN_VS_ACTUAL_PLAN.md) adds BUD-00–BUD-05 implementation tasks and BP01–BP12 acceptance cases. Apply those when that feature is implemented; they are not claims about existing UI behavior or an instruction to expand this testing task into feature work. Its final acceptance depends on closing the transaction-save blocker.

## Execution contract for a smaller model

1. Work serially on one task below. Read Git status, that task, its case IDs, and only the relevant files. Preserve unrelated edits. Do not spawn agents or redesign the application.
2. Record the candidate commit and a hash/manifest of any uncommitted source used in tests. Old screenshots or a previous green run do not verify the current patch.
3. Reproduce a suspected product defect with visible actions and inspect the persisted result. Write a focused regression that fails for the observed reason before the repair, then make the smallest repair and rerun it. Harness-only corrections need evidence that the intended guard detects a deliberate synthetic failure.
4. Distinguish `PASS`, `FAIL`, `BLOCKED`, and `NOT_RUN` for every case. A missing browser, bad fixture, selector mismatch, or server startup failure is a harness/environment problem until evidence shows a product defect. Never convert a retry into a silent pass.
5. Use only private disposable synthetic data, local browsers, loopback addresses, and explicit config/data paths. No owner config, records, bank connections, real sync, deployment, service/timer changes, or private recovery operations are part of this testing task.
6. Existing financial contracts in README and shared modules apply. Check independent expected amounts, record IDs, revisions, and unaffected records, rather than computing expected values with the same function being tested.
7. Finish a task with changed files, commands and exit status, case results, evidence path, and next task. Do not mark the whole experience accepted from a smoke test or automated accessibility scan.

## What the current suite actually establishes

These are source observations, not newly reproduced product defects.

| Current source/test evidence | Gap to address |
| --- | --- |
| One sequential journey with many shared records | Early failure prevents later checks; row order and previous steps can determine outcomes. |
| Synthetic config contains `enablePlaid:false` but no `storageMode` | Runtime selects JSON by default. Current browser success is not SQLite browser acceptance. |
| Global dialog handler accepts every confirmation | Cancel and precise action intent are untested. |
| Browser errors append to a log | Unhandled page/console errors need an explicit failure gate. |
| Fixed October 2026 imports and contribution assertion, mixed with the current month/date | Tests can age out or cross a reporting-month boundary. |
| In `ui/browser.js`, `refresh()` clears `data.transactions`; row editing in `bindCategories()` resolves a row through `rows()` | Source-identified risk: paged UI rows may be missing from the edit lookup, causing an undefined-row error before save. Reproduce B01; do not label the root cause confirmed from source alone. |
| Bulk selection/API cap is 100; the table pages at 50 rows | B02 must exercise 49/50/51/99/100/101 selections and 121 matching rows. “All” cannot silently mean a smaller set. |
| One category is recategorized through `page.evaluate(fetch(...))` | This proves setup/API behavior, not the row editor interaction. |
| Fixed 100 ms delay in navigation | Waiting for a render does not establish completion of the relevant request. |
| 409s are fulfilled with a fake response | Useful error coverage, but no real concurrent revision change or successful conflict recovery. |
| Preview text equals saved text | Both could be wrong in the same way; an independent numeric oracle is also required. |
| Final width loop checks the currently open Home view; labels say category | Does not prove every page or dialog at those widths. |
| 720 CSS px proxy is printed as 200% zoom | Rename evidence accurately; actual browser zoom remains a distinct manual check. |
| Temporary directory is removed in `finally` | Failure screenshots, trace, logs, and reproducible fixtures need retention before cleanup. |

R06 repairs are regression requirements, not a new list of confirmed failures. R07 owner acceptance applies to that deployment; it is not evidence that new cases or future changes pass.

## Task queue and acceptance gates

All tasks start **NOT_STARTED**. Execute TST-00 through TST-07 in order, with one priority exception: reproduce B01/B02 during baseline and repair the reported transaction-save failure before broader feature work. Add only the harness support needed for trustworthy reproduction first. Record external manual gaps while finishing independent work.

| Task | Concrete work | Done when |
| --- | --- | --- |
| TST-00: reproducible baseline | Inspect current scripts/runtime; create isolated source copy including intended changes; run existing gates once; capture actual failing cases and environment. | Candidate identity, commands, backend, dates, and baseline results are recorded. An existing failure stays visible. |
| TST-01: trustworthy runner | Correct the harness gaps below; preserve existing coverage while splitting cases into independently runnable groups. | Each group can run alone; explicit SQLite and JSON runs work; artifacts survive failure; unexpected JS errors fail; no blanket confirmation acceptance. |
| TST-02: everyday transaction journeys | Close the owner-reported B01/B02 save issue first, then implement B03–B06, including exact CSV membership, page boundaries, real row edits, stale query results, and cancel/undo. | UI actions and saved-state assertions pass in SQLite; affected query/mutation contracts pass in JSON too. |
| TST-03: save and recovery behavior | Implement F01–F07 for the forms listed below, including real two-tab conflict and successful retry. | Drafts, modes, focus, and unaffected records survive; saves are not duplicated; reload confirms the final value. |
| TST-04: financial journeys | Implement B07–B10 with independent arithmetic and fresh/stale account variants. | Visible totals agree with the fixture oracle, persistence, and targeted finance tests. |
| TST-05: access and presentation | Implement B00, B11–B13 and the page/dialog viewport matrix. | Keyboard, responsive, loading/error, sample-mode isolation, and automated accessibility cases have per-case evidence. |
| TST-06: agent-browser exploration | Follow the paired playbook against the same source candidate and fresh SQLite fixture. | Every mandatory journey has steps, outcome, and evidence; new defects are reproduced or explicitly intermittent. |
| TST-07: final verification/handoff | Run integrated gates once after the final patch; review diff; update progress with coverage and residual gaps. | All required automated cases pass, or the handoff explicitly states incomplete acceptance and the remaining failures/blockers. |

A fix discovered in a later task gets a targeted regression immediately; do not postpone it just to preserve table order. Never commit or push merely because a task row says complete; follow the active user instruction.

## TST-00: safe, repeatable setup

Read `package.json`, `scripts/run-node.sh`, `scripts/start-ledger.sh`, and `scripts/runtime.mjs`. Use Node 24.22.1; do not upgrade dependencies as a test repair.

Run builds and checks in a disposable source copy. Include current working-tree versions of `package.json`, `package-lock.json`, `.node-version`, and the `worker/`, `ui/`, `shared/`, `server/`, `scripts/`, and `deploy/` source directories. Exclude `dist/`, `.git/`, `.sites-runtime/`, `.openai/`, `outputs/`, private documents, configs, records, and owner `node_modules/`. Copy only reviewed source files from those directories, not unexpected artifacts. Do not use a commit-only archive when the intended patch is uncommitted.

Set the runtime before installing/building inside that copy:

```sh
export LEDGER_NODE_BIN="$HOME/.local/share/ledger/runtimes/node-v24.22.1/bin/node"
export PATH="$(dirname "$LEDGER_NODE_BIN"):$PATH"
node --version
npm ci
npm run check
npm run check:local-http
npm run check:browser
```

The version must be exactly `v24.22.1`. These are existing commands; `check:browser` uses already-built output and is not included in `npm run check`. If Chromium is missing, inspect the installed Playwright CLI and install its matching Chromium locally using the pinned dependency. Record the browser version. Do not keep rerunning the suite against a missing executable.

For a separate exploratory server, create a mode-0700 temporary root with separate `state/`, `artifacts/`, and mode-0600 `config.json` containing:

```json
{"storageMode":"sqlite","enablePlaid":false}
```

Set `LEDGER_CONFIG_FILE` and `LEDGER_LOCAL_DATA_DIR` to those absolute disposable paths. Start `PORT=0 bash scripts/start-ledger.sh` from the built copy, capture its PID and printed `Ledger: http://127.0.0.1:<port>` URL, and use only that URL. The wrapper obtains the writer lock; do not run the server directly. Wait for `/api/health` with a deadline and verify `localOnly:true`, the recorded build identity, and expected schema version from the source. Confirm the configured backend and creation of the disposable SQLite file; schemaVersion alone is not a backend discriminator.

For JSON parity, use a separate fresh root and config `{"enablePlaid":false}`; never switch backends in an existing data directory. Runtime status reads host systemd state even with synthetic storage: use the existing `check-runtime-status.mjs` stub pattern or targeted response fixtures for deterministic timer cases. Do not assert that a test instance's timers are disabled simply because Plaid is off.

On completion, close the browser and stop only the captured child server. Verify its exit before removing synthetic state. Keep the report and failure evidence in the separate artifact root. Never use broad `pkill`, delete owner directories, or restart the owner's app.

## TST-01: harness requirements

Keep `npm run check:browser` as the full-suite entry point. A small extraction into `scripts/browser/` is acceptable; avoid a test-framework migration unless necessary.

- Add a documented case/group selector so one failed case can run with its own fixture. Proposed names such as `BROWSER_CASE` and `BROWSER_STORAGE` are **not supported today**; implement and document them before using them. Full default execution must enumerate all mandatory cases and return nonzero for any failure.
- Each group gets a fresh browser context and a known database baseline. Run serially by default. No reliance on an earlier group's create/import/rename steps. Return fixture IDs explicitly; scope locators to a named card/row instead of arbitrary `.first()` or `.nth()`.
- Fixture/setup APIs may seed records. User actions under test must use rendered controls. Read-only API/database observations may corroborate results. UI evidence must include visible amounts, labels, enabled controls, and status, not merely an HTTP 200.
- Register request/download/dialog waiters before the action. Match method, path, and relevant request identity. Wait for a visible result or explicit response, not arbitrary sleeps or global network-idle on polling pages.
- Default dialogs to unexpected/failing. For each expected confirmation assert the action/entity in its message and choose accept or dismiss explicitly. Test both paths.
- Collect unhandled page errors, console errors, and failed/unexpected API responses by case. Fail on unexpected ones. Failure injection uses an exact case-scoped allowlist by endpoint and failure; remove it immediately afterward. Do not suppress every error with similar text.
- Retain trace/screenshots on failure, console/network summary, failed locator and current DOM snapshot, actual/expected values, source identity, storage mode, seed, dates, viewport, runtime/browser versions, and case duration. Synthetic traces can contain fixture data; never use production traces.
- Give actions/readiness a bounded timeout (start with 10 s actions, 20 s server readiness, 90 s case; document justified exceptions). Always perform cleanup on timeout. One diagnostic rerun is allowed; first-run failure remains recorded and an intermittent failure is not green.
- For long names or duplicate labels, use a stable record ID to scope the row and accessible role/name within it. Add minimal accessible labels if needed; do not hide defects using force clicks, DOM value assignment, or CSS injection.
- Verify the error gate by inducing one synthetic uncaught error. Verify retention by deliberately failing one assertion, checking the report exists after shutdown, then restoring the test. Do not ship those deliberate failures.
- Keep API/money boundaries in existing `check-finance.mjs`, `check-sqlite.mjs`, and `check-dev.mjs`. Add browser assertions where actual interaction, focus, layout, history, or saved-state feedback matters.

### Dates and fixture determinism

Use explicit reporting dates in America/Chicago. Do not mix a fixed October import with whatever month the UI selects today.

For normal browser journeys, derive one reporting date and its current/previous/next months at run start, use those dates for imports and fresh balance observations, and select the intended month explicitly. Refuse/restart a setup that crosses a reporting-date boundary. Fixed historical transaction cases may use October 2026 if they navigate explicitly to that month.

For date-sensitive unit/API tests pass a fixed `asOf` where supported. Browser clock manipulation alone does not freeze the server. If a case requires a fixed cross-process clock, add a narrowly scoped test fixture/dependency seam rather than a production query parameter or system-clock change. Cover leap February, December/January, Chicago/UTC midnight, due-today, and month-end contribution boundaries in focused tests; do not multiply every browser case by every date.

### Fixture F-MONEY: independently checkable values

All dates are in the selected reporting month unless marked otherwise. Values below are dollars; stored amounts are integer cents. Positive transaction amount is spending. Use unique synthetic merchant/record IDs.

| Transaction | Amount | Category/state |
| --- | ---: | --- |
| Payroll | -1,000.00 | Income, posted USD |
| Market | 100.00 | Groceries, posted USD |
| Market refund | -20.00 | Groceries, posted USD |
| Cafe | 30.00 | Dining, posted USD |
| Card payment | 200.00 | Transfers, posted USD |
| Pending shop | 50.00 | Shopping, pending USD |
| Foreign shop | 70.00 | Shopping, posted CAD |
| Prior-month market | 11.00 | Groceries, posted USD, previous month |

Expected selected-month income = **$1,000**, spending = **$110**, net cash flow = **$890**, Groceries = **$80**, Dining = **$30**. Pending, foreign currency, transfer, and prior-month rows must not inflate those totals. They remain viewable where filters permit. Recategorizing Market to Shopping changes category totals, not $110 total spending. Do not derive these expected numbers by calling `totals()`.

Use a separate pagination fixture with 121 uniquely identified matching rows across two accounts and multiple dates, plus nonmatching rows. Check first, middle, last, and empty pages; filtering from the last page must recover to a valid page. Downloaded CSV contains the exact matching multiset once, including records beyond the visible page. Add tied dates/merchant names to test deterministic ordering.

For account/goal cases use independent fresh manual USD balances: cash $1,000, retirement $12,000, liability $2,000. Expected assets $13,000, liabilities $2,000, net worth $11,000; eligible goal cash $1,000. Reserve $700 for higher-priority goal A and $500 for B: total fresh backing cannot exceed $1,000 (A $700/B $300 with explicit priorities). Keep CSV-created accounts out of this fixture. Stale, excluded, archived, non-USD, missing, zero, and negative-available variants are separate cases.

## TST-03: failure and recovery matrix

Apply each row to these groups: category create/rename and row/bulk assignment; recurring budget, month override and reset; manual account edit; goal/allocation; scenario save and apply action. Use a small shared injection helper, with assertions specific to each form's fields and side effects. Do not reduce coverage to one representative form.

| ID | Controlled setup/action | Required observation |
| --- | --- | --- |
| F01 | Hold the mutation response for 1.5 s; click Save twice and press Enter while pending. | Clear pending feedback; one intended mutation, no duplicate record/action, no silent success before acknowledgement. Request counts and persisted effects both checked. |
| F02 | Abort the mutation before it reaches the server. | Persistent understandable error; all draft fields and selections intact; no persisted change; retry after restoring network succeeds once. |
| F03 | Respond once with 500 JSON, then separately 502 HTML/text. | Readable failure, no JSON-parser error or blank page, draft/focus retained; retry persists once. |
| F04 | Open tabs A/B on the same revision. A saves a change; B submits a different stale draft. | Actual backend rejects stale write; A's change survives; B sees conflict and keeps draft; explicit retry with current revision or clear reapply path succeeds without silently dropping A's unrelated change. |
| F05 | Allow the server to commit, then lose its response. | Reload/read-back detects the committed result. Retrying cannot duplicate import, goal, scenario, or other non-idempotent action; uncertainty must be communicated. Do not claim this is covered by an abort before delivery. |
| F06 | Delay query A, trigger query B via search/month/navigation, let B finish then A. | B's URL, controls, rows, totals, and status remain authoritative. An old response cannot replace the current view or clear a current draft. |
| F07 | Load saved data, then fail refresh; separately fail initial load and recover. | Existing saved data remains labeled as stale/error when appropriate; empty/error/loading are distinct; retry reaches correct state; sample data appears only after explicit choice. |

For each failure capture the full relevant draft (including budget mode, scenario costs/linked goal, account type/date, selected rows), not just its name. Assert focus is visible and useful, error is associated/announced, form stays usable, and reload after recovery shows the final value. Check no unintended revision advance when a request was rejected before mutation; successful mutations follow the route's revision contract.

For F04, choose unrelated edits as well as the same record: a conflict fix must not overwrite a different tab's unrelated saved work. For F05 use Playwright interception that forwards to the disposable server before dropping the reply, or an isolated proxy; record the server-side effect before retry. Do not inject faults into the live service.

## Verification commands and scope

Run the smallest relevant existing check after each fix, inside the built disposable copy:

| Change | Focused checks |
| --- | --- |
| Category, budget, goal, scenario or transaction logic | `bash scripts/run-node.sh scripts/check-finance.mjs`; SQLite check when persistence/query behavior changes |
| SQLite query/revision/restart | `npm run check:sqlite`; `npm run check:local-http` for HTTP/restart behavior |
| Browser UI/focus/async behavior | Affected independent browser group; full browser suite after integration |
| Backup/runtime status presentation | `npm run check:runtime`, relevant browser fixture, `npm run check:backup` only if backup behavior changes |

Final integrated gates: `npm run check`, `npm run check:local-http`, `npm run check:browser`, and `git diff --check`. Run `npm run check:source` in the real Git checkout when appropriate; it inspects the **index**, so it does not validate unstaged/new content or a source copy without Git. Review the actual new/modified files separately. Do not stage merely to make the check pass.

Use existing `npm run measure:performance` only when query/render/storage changes or measured regressions justify it; compare with `docs/PERFORMANCE_BASELINE.md` on the same hardware. For a routine interaction case, record the delay and diagnose a visible stall; do not invent a new universal performance threshold.

No full-suite repetition after a green final gate unless source, fixture, environment, or a new failure warrants it. Documentation-only changes need link/path/command and diff checks, not a full application test run.

## Handoff record

Append a concise execution entry to `docs/IMPLEMENTATION_PROGRESS.md`:

```text
Task / case IDs:
Candidate commit + working-tree manifest:
Environment: Node / browser / backend / dates / viewport:
Status: PASS | FAIL | BLOCKED | NOT_RUN
Defect classification and severity:
Reproduction, expected, observed:
Fix and changed files:
Regression: failed before / passed after (or harness-only verification):
Commands and exit status:
Evidence path:
Remaining cases and exact next task:
```

Report counts by status and list all failing/blocked/not-run case IDs. A complete test implementation and a successful product acceptance are separate claims. Screen-reader behavior and actual 200% zoom require explicit manual evidence; keep them unverified if unavailable without erasing R07's historical owner acceptance.
