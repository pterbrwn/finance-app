# Test automation review and improvement plan

Reviewed 2026-10-29 against the working tree based on `6d5fc0cfadf6e82c0bc65ef78329e8c9a51f0834`. The checkout contains substantial modified and untracked implementation; HEAD alone does not identify the reviewed candidate. This is a source inspection and implementation plan, not a fresh test execution report. Node 24.22.1 is available; `age` was not found on PATH. No application suites, live services, bank connections, or owner data were exercised for this review.

## Assessment

The automation has valuable foundations: exact-cent assertions, real SQLite rollback and operation replay checks, synthetic backup corruption/interruption tests, browser accessibility checks, private failure artifacts, and packaged-release checks. Preserve these. A green default command is currently insufficient evidence that the complete finance tool is ready to release.

“Perfect” cannot mean defect-free software. The target is a reproducible system that detects the important failures, reports omissions honestly, and proves that the exact release can preserve and recover financial records. Coverage percentages alone do not establish that confidence.

### Confirmed findings

| Priority | Finding and source | Consequence |
| --- | --- | --- |
| P0 | `package.json` runs build, validation, model/storage/recovery checks through `check`, but omits local HTTP, browser acceptance, named browser cases, harness self-tests, source scans, and packaged release checks. `check-dev.mjs` explicitly skips HTTP without `--http`. | Default green does not mean complete acceptance. |
| P0 | `check-encrypted-backup.mjs` has only two missing-configuration assertions. Its called functions fall back to environment variables even when passed `{}`. | No proof that encryption/decryption pipelines work; inherited operator configuration can change the test's behavior. |
| P0 | `browser-cases.mjs` has early successful returns without uniform checks of collected page, console, and API errors. Its page-error self-check explicitly throws after inspecting the error. | Artifact handling is tested, but automatic rejection of unexpected errors on every successful path is not established. |
| P0 | `prepare-release.sh` copies an explicit script list that excludes `encrypted-backup.mjs` and `portable-export.mjs`; `check-release.mjs` does not exercise those entry points. | A package can pass existing release checks without delivering these new commands. |
| P1 | `check-browser.mjs` runs either the default acceptance scenario or one `BROWSER_CASE`; it does not enumerate all named cases. `browser-cases.mjs` lists 16 product cases and two intentional-failure cases. | Important regressions depend on somebody remembering separate commands. |
| P1 | Individual browser/domain commands can consume an existing `dist`; release preparation uses committed Git archive source while ordinary checks use the working tree. | Evidence can refer to a stale build or a different candidate from the release. |
| P1 | New commitment/split/reimbursement route checks use in-memory repository mocks; several manually advance revisions. Existing SQLite tests are stronger but do not substitute for exercising every new route's real persistence. | A passing route test need not prove atomicity, restart durability, or concurrency behavior. |
| P1 | `check-portable-export.mjs` uses a small, manually migrated fixture and a few malformed-reference/version checks. Its success text includes consistency and bounds claims broader than its demonstrated cases. | Full field preservation, concurrent snapshot consistency, and validation boundaries remain insufficiently demonstrated. |
| P1 | `check-source.mjs` reads tracked Git index content via `git show :path`, not current working-tree/new-file contents. Its patterns are explicitly narrower than a comprehensive secret scanner. | Dirty candidate checks can miss newly introduced source and secrets. |
| P1 | Browser cases contain fixed waits and duplicated lifecycle code. The main browser scenario is about 580 lines; named cases occupy about 1,078 lines. | Timing sensitivity, inconsistent teardown/error checks, and costly diagnosis grow with each feature. |
| P2 | No checked-in GitHub/GitLab CI or conventional test-runner configuration was found by targeted discovery. Performance measurements exist, but a required baseline gate is not wired into `check`. | Enforcement and regression tracking appear manual; external CI settings were not inspected. |

The existing harness self-test is useful: it checks nonzero exits and private screenshot/trace/request artifacts. The SQLite and backup suites already cover several failure modes, including failed operation insertion, corruption, wrong paired keys, interrupted publication, and lock contention. Extend these rather than replacing them with mocks.

## Execution boundaries

- All tasks below start **NOT_STARTED**. This review changes only this document.
- Preserve the dirty original checkout. Do not stage, commit, reset, deploy, activate releases, change services, or access banks as part of test work without separate authorization.
- Do not read, copy, scan, or modify `docs/IMPLEMENTATION_PROGRESS.md` or `docs/STABILITY_REVIEW_2026-10-27.md`. Use an explicit permitted-source manifest for snapshots and scans; do not recursively copy the checkout.
- Use disposable synthetic data and explicit configurations. Never inherit owner database/configuration/export/recovery paths. Keep artifacts private. No real credentials or financial records belong in fixtures.
- Preserve Node 24.22.1, locked dependencies, the current JavaScript architecture, and financial contracts. Do not add a framework or upgrade dependencies merely to pass checks. Prefer Node's built-in test facilities and the already installed Playwright tooling where useful.
- Work sequentially. Start with a failing behavioral regression, implement the smallest change, run focused checks, and record evidence. Run integrated profiles at increment boundaries. Do not weaken expected results to match implementation.
- Provision missing test prerequisites only through separately authorized environment setup. Missing `age` must block the required recovery gate, never become a successful skipped test. No tooling installation is part of this review.

## Implementation sequence

### T00 — Establish contracts and candidate identity (P0)

**Surfaces:** package scripts, existing check scripts, a new test manifest and `docs/TEST_AUTOMATION_EXECUTION.md`.

Inventory every suite and selectable case, its contracts, backend, prerequisites, estimated cost, and required profiles. Capture an allowed-source content digest including modified and new files, the base commit, lockfile digest, schema, runtime, and platform. Build from that disposable candidate and record the artifact digest. Record assumptions separately from proven behavior.

Create a traceability table linking each critical contract below to its executable test IDs. Expected money/status values must come from hand-worked fixtures or a small independent reference model, not the production function being tested.

**Accept when:** changing a permitted untracked source file changes the candidate digest; modifying source after building causes dependent acceptance to rebuild or reject stale artifacts; excluded/private files are never opened. Every existing suite and all 16 named product cases appear in the inventory. Self-check cases are marked as expected-failure harness tests.

### T01 — Make fixtures and subprocesses hermetic (P0; depends on T00)

**Surfaces:** common test helpers; all scripts starting processes or invoking recovery.

Provide fresh synthetic SQLite/configuration and a minimal child environment with explicitly selected PATH/runtime/temp settings. Remove inherited `LEDGER_*`, provider credentials, release destinations, and `BROWSER_CASE` unless deliberately set by the test. Pass explicit recovery arguments, including invalid values for configuration tests. Resolve paths within a disposable test root and assert that boundary before writes/deletion. Disable provider integration; constrain test runtime network access to loopback through an enforceable runner boundary, with browser/request assertions as additional evidence. Dependency installation is a separate phase.

Use a fixed clock and seeded fixture generator; report seeds. Exercise date-sensitive contracts with UTC and America/Chicago, leap years, month boundaries, and DST. Prefer actual server-assigned port zero over reserve-and-release port selection. Centralize deadlines, child exit/error handling, signal escalation, and cleanup of browser/server descendants.

**Accept when:** hostile synthetic environment variables cannot redirect reads/writes; a non-loopback sentinel request is blocked; frozen dates yield identical results; startup failure, hang, cancellation, and forced child termination leave no test listener/process or partially published output. Cleanup must preserve the original failure and its diagnostics.

### T02 — Define complete profiles and honest reporting (P0; depends on T01)

**Surfaces:** `package.json`, a single test registry/runner, reporting helpers.

Add the proposed commands below. Existing commands may remain convenient focused entry points, but the registry is the source of truth for required suites. Discover all registered browser cases; reject duplicates, unknown IDs, zero tests, missing required cases, and unexpected omissions. Build the candidate once for a profile and verify its identity throughout.

Emit console summaries plus JSON/JUnit with suite/case ID, PASS/FAIL/NOT_RUN/BLOCKED, duration, seed, candidate/build identity, backend, prerequisites, exit/signal, and private artifact location. A required FAIL, NOT_RUN, or BLOCKED makes the profile nonzero. Optional manual observations remain visibly separate. Test timeout, runner crash, and failed report writing must not manufacture success.

**Accept when:** adding a registered product case makes the complete browser profile execute it; an intentionally broken omitted suite fails the release profile; missing browser binaries or `age` are reported accurately. A self-test child is expected to fail, but its parent harness contract must pass.

### T03 — Repair browser harness guarantees (P0; depends on T02)

**Surfaces:** `check-browser.mjs`, `browser-cases.mjs`, `check-browser-harness.mjs`.

Run common postconditions after every case body and before reporting success, including cases that return early. Require no unexpected page errors, console errors, API failures, dialogs, or sample writes. Describe intentional failures narrowly by request/method/status/count and verify that each expected failure actually occurred. Handle resource-load console messages through network assertions rather than blanket suppression.

Change the page-error self-check to inject the error and otherwise finish successfully: only the common harness guard should fail it. Add analogous self-checks for console/API errors, startup failure, timeout, and cleanup failure. Verify trace/screenshot/log privacy and retain enough evidence when a page never starts. Apply bounded artifact capture so diagnostics cannot hang the runner.

**Accept when:** each injected failure causes nonzero completion through the same guard used by normal cases; removing that guard makes the harness self-test fail. An early-return case with an unexpected error cannot pass. No children survive any harness failure mode.

### T04 — Prove real encrypted recovery and package completeness (P0; depends on T03)

**Surfaces:** `check-encrypted-backup.mjs`, `check-release.mjs`, `prepare-release.sh`, recovery/export entry points.

With an explicitly provisioned real `age` executable, generate an ephemeral identity and a synthetic database/configuration pair containing an encrypted sentinel provider token. Create the recovery bundle, encrypt, decrypt/rehearse into a new directory, open the restored database, verify schema/integrity/IDs/cents/audit history, and decrypt the sentinel with the restored configuration. Assert that reported verification states describe checks actually performed. Never perform provider calls.

Exercise wrong identity, truncated/corrupted ciphertext, missing tools, subprocess failure, interruption, destination collision, unsafe archive entries, ENOSPC injection, and permissions. Prove bounded termination, no overwrite, no published partial success, and preservation of the last valid recovery artifact. Assert plaintext temporaries disappear. Use deterministic fault injection for hard-to-reproduce failures and a real crypto round trip for the pipeline itself; distinguish those evidence types.

Define the promised operational CLI inventory. Require encrypted recovery and portable export plus their transitive imports in the package; execute each from the immutable release using only production dependencies. Prepare a disposable Git repository from the permitted candidate snapshot, commit there, and use a temporary release root. Keep the original checkout and actual service untouched. Retain existing manifest/schema/backup/rollback checks and their systemctl stub.

**Accept when:** a real round trip passes on a provisioned runner; omitting either new CLI fails release acceptance; the complete package works independently of source-tree modules. On the current host without `age`, this task remains BLOCKED until an authorized test environment provides it.

### T05 — Strengthen independent financial oracles (P1; depends on T04)

**Surfaces:** model checks and new focused domain tests for money, budgets, splits, commitments, reporting, reconciliation, and forecasts.

Use small reviewed examples plus deterministic generated cases. Assert conservation and sign rules, safe integer boundaries, invalid dates/currencies, unknown versus zero, and provider-fact immutability. Preserve weekly ×4, annual ÷12, and semiannual ÷6 budget rules; calendar occurrences remain actual calendar dates. Cross-check domain results, API summaries, and displayed totals against the same independent expected ledger.

Add targeted mutation checks in disposable source: invert refund signs, omit a split allocation, count a transfer as spending, erase pre-cancellation occurrences, accept duplicate matches, trust a missing payment, or treat null as zero. Each named mutation must be killed by its designated test. Use these as concrete regression sensitivity checks rather than an arbitrary global mutation score.

**Accept when:** all critical contract rows have independently calculated expectations; known bad behaviors fail; generated failures print a reproducible seed and minimal fixture. Do not calculate expected results with the implementation under test.

### T06 — Exercise actual persistence, concurrency, and restart (P1; depends on T05)

**Surfaces:** SQLite/HTTP integration suites, repository factories, operation recovery, new finance routes.

Run new split, reimbursement, commitment, reconciliation, and budget-history contracts against a real SQLite repository and the HTTP boundary. Retain mocks for focused routing tests. Test any supported legacy JSON backend against an explicit compatibility matrix; if a feature is SQLite-only, verify a clear refusal rather than assuming parity.

Coordinate independent connections/processes with barriers: same operation ID/same payload, same ID/different payload, competing revisions, two tabs, provider corrections, and retries after a lost response/restart. Reopen the database to verify persisted facts, revision, audit history, and operation result all agree. Inject failure between domain mutation and replay publication; verify all-or-nothing rollback. Test upgrades from every supported schema fixture, interrupted migration, unsupported future schema, foreign keys, and preservation of history.

**Accept when:** exactly one valid effect survives duplicate submissions; a conflict cannot silently overwrite newer data; no test manually repairs revisions to make a persistence assertion pass; restart and rollback results are checked from a fresh connection. Existing SQLite regression checks remain intact.

### T07 — Complete portable export and boundary security tests (P1; depends on T06)

**Surfaces:** portable export, local HTTP checks, source scanning, runtime/status payloads.

Create a production-migrated synthetic fixture covering every supported export collection, including budgets/history, reconciliations, splits, reimbursements, commitments, goals, properties, and scenarios as applicable to the format contract. Validate all IDs, references, cents, limits, optional fields, unsupported versions, and secret exclusion. Coordinate a concurrent writer and prove the export is one consistent revision. Test output collisions, failure atomicity, and permissions. Do not claim an import/restore round trip unless a supported portable importer exists; encrypted recovery has its separate round trip.

Make HTTP authorization/origin/identity checks required; test forged forwarding/identity headers, unauthorized mutations, malformed and oversized requests, secret-bearing error paths, and writable endpoints in sample mode. Verify denied operations leave data and revision unchanged. Scan the permitted candidate source, including new files, instead of relying solely on Git index content. Retain an index/release scan as a distinct check. Use synthetic secret canaries, redacted diagnostics, and narrowly documented false-positive exceptions. Record dependency advisories separately with explicit unresolved disposition; do not silently upgrade packages.

**Accept when:** a synthetic credential in a new permitted source file is caught without printing it; exported/status/browser storage payloads contain no secret sentinels; concurrent export remains internally consistent; each claimed validation bound has a negative assertion.

### T08 — Make browser acceptance maintainable and product-focused (P1; depends on T07)

**Surfaces:** named browser cases and shared UI/fixture helpers.

Split the large scenarios into isolated tests using the existing tooling and shared lifecycle. Preserve the registry IDs and all existing assertions. Replace arbitrary sleeps with observable save status, response, revision, or UI conditions. Prefer accessible role/name locators; use stable test IDs where no meaningful user-facing target exists. Keep financial fixtures independent of UI helpers. Begin with one browser worker on Jetson; increase only after resource measurements justify it.

Cover complete owner journeys: empty-account onboarding; selected-month budget persistence; editing/undo/history; searching beyond the current transaction page; reviewing and unlinking reimbursements; payment corrections; uncertain-save recovery; and truthful stale/incomplete/recovery status. Verify persisted results after reload as well as success messages. Include new dialogs, keyboard focus/escape/return, validation errors, narrow viewports, and accessibility scans. Label 720 CSS px as a reflow approximation, not proof of physical zoom or screen-reader usability.

**Accept when:** all registered cases run independently and in the full profile; isolated repetition and different case orders reveal no state leakage. Complete ten consecutive clean browser-profile runs on each declared supported release target during stabilization; any failure needs diagnosis, not a hidden retry. Keep real zoom and assistive-technology checks in a separately reported manual checklist.

### T09 — Automate enforcement and measured performance (P1/P2; depends on T08)

**Surfaces:** provider-neutral runner commands, chosen CI workflow, performance scripts, release evidence report.

Wire profiles into the repository's selected CI service; first confirm remote/provider configuration without assuming GitHub. Use clean runners with no owner data or production credentials, pinned runtime/dependencies/browser/tool versions, bounded jobs, and private artifact retention. Do not execute untrusted pull-request code on the owner's Jetson. Use isolated x64 Linux checks where available and a dedicated isolated ARM64 environment for Jetson release validation, including native SQLite and available browser binaries. Report unsupported platform capabilities explicitly; do not silently substitute x64 evidence for ARM64.

Run fast/integration/browser gates for candidate changes; run crypto/package gates before release and on affected recovery changes. Run extended failure/seed/mutation/performance checks on schedule and before release. Scheduled results must identify their source; old results cannot certify a newer candidate. Require all designated checks through repository branch/release rules when administrative configuration is authorized.

Extend existing 10k/100k synthetic performance measurements with stored baselines for p95 latency, response bytes, RSS, event-loop delay, backup/restore, and operation-store growth. Establish tolerances from repeated measurements on a named runner class, then fail reproducible regressions. Preserve absolute correctness and bounded-response assertions even on variable-speed hosts. Treat one cold sample as a cold measurement, not a meaningful p95 distribution.

**Accept when:** a deliberately failing required check prevents candidate acceptance; every release report refers to the exact packaged digest; no required skipped check is green; baseline comparisons are reproducible on the documented platform. Record duration and flake trends and assign an owner to failures.

## Proposed command profiles

These commands are proposals, not currently available commands. Build/validate and hermetic setup are shared prerequisites; a runner may reuse verified results within the same candidate run.

| Command | Required scope | When |
| --- | --- | --- |
| `npm run test:fast` | Pure financial contracts, validation, focused request/UI logic, runner self-checks | Each relevant edit |
| `npm run test:integration` | Real SQLite, supported backend contracts, local HTTP security, migrations, replay/restart, backup/export | Candidate changes |
| `npm run test:browser` | Existing broad acceptance plus every registered product case and harness self-tests | Candidate changes |
| `npm run test:recovery` | Real crypto round trip and recovery fault cases | Recovery changes and release |
| `npm run test:release` | All required profiles, permitted-source security checks, exact immutable package checks, complete evidence | Every release candidate |
| `npm run test:extended` | Additional seeds, targeted mutations, longer fault scenarios, baseline performance and growth checks | Scheduled and before release |

Retain `npm run check` as a documented alias with an explicit scope; never describe it as complete acceptance unless it invokes the complete required profile. The release runner should avoid recursively invoking itself when composing profiles.

## Critical contract matrix

| Contract | Required evidence |
| --- | --- |
| Money is conserved | Exact cents and safe bounds; split sum equals signed parent; refund capacity cannot exceed permitted amounts; null differs from zero. Domain oracle + real persistence + visible totals. |
| Budget history is durable | Recurring/month overrides, zero/reset, frequency rounding, archives and stop-funding preserve earlier periods and agree across views after restart. |
| Reporting is explainable | Pending/non-USD exclusion; transfer exclusion from spending but inclusion in account reconciliation; balance signs/date windows; discrepancies and incomplete history remain visible. |
| Obligations are honest | Actual due dates, effective cancellation, unique reviewed payment matches, changed/deleted transactions require review, forecasts never silently double count matched payments. |
| Reimbursements are reviewable | Opposite signs, currency/pending rules, bounded totals, search pagination, provider correction, unlink audit, and persistence after reload. |
| Saves are reliable | Atomic data/revision/audit/operation result; deduplicated retry; correct stale-revision conflict; lost response, restart, reload, and safe recovery metadata. |
| Imports/sync preserve facts | Preview/commit/undo, duplicates, corrections, cursor/data atomicity, interrupted/repeated mocked provider pages, and category overrides. No live provider access. |
| Recovery is usable | Backup plus matching key/config restores independently; real encrypted round trip; corruption/failure preserves last valid artifact; status reflects verified facts. |
| Security boundaries hold | Unauthorized or wrong-origin writes fail without mutation; secrets stay out of public exports/status/logs/browser storage; sample mode writes nothing. |
| The delivered product works | Packaged entry points and dependencies exist, assets/schema/build identity match, compatible rollback works, incompatible downgrade refuses. |
| Owner workflows are accessible | Fresh setup through edit/review/reload, keyboard and dialog behavior, narrow layouts, automated accessibility plus separately identified manual checks. |

## Evidence and completion criteria

For every task record status, candidate digest, failing reproduction, independent expectation, changed files, exact commands/exits, platform/backend/seed, artifacts, and remaining limitations in the new execution document. No prior green suite substitutes for a new regression's evidence.

Deliver three increments: **A: T00–T04, trustworthy results and real recovery/package proof; B: T05–T07, financial/storage/security contracts; C: T08–T09, sustainable product acceptance and enforcement.** Do not mark an increment complete with a required dependency blocked.

The plan is complete only when all critical contract rows map to passing executable tests, all registered cases run under required profiles, designated bad-behavior mutations are detected, recovery succeeds with real encryption, every packaged CLI is exercised, failures retain private useful diagnostics and clean up, and release evidence matches the artifact being shipped. Report manual accessibility observations and operational checks separately. These gates substantially improve confidence; they do not constitute a guarantee of no future defects.
