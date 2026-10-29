# Test automation implementation record

Started 2026-10-29. Candidate base commit: `6d5fc0cfadf6e82c0bc65ef78329e8c9a51f0834`. The checkout already contained unrelated dirty implementation before this work; changes below are incremental. No protected documents were opened or included.

## T00–T03 initial implementation

Status: **IN_PROGRESS**. Added named test profiles and a runner that clears inherited `LEDGER_*`, provider, and browser case variables; uses a private temporary HOME/TMP directory; builds before profiles; hashes permitted candidate source before and after execution; records PASS/FAIL/BLOCKED/NOT_RUN; runs registered browser product cases; and retains its private runner directory on failure. The runner applies a 120-second suite deadline and escalates termination. Browser cache location is passed explicitly so isolation does not hide the installed browser.

Browser product cases now check uncaught page and console errors before every successful early return. The source scanner explicitly skips `docs/IMPLEMENTATION_PROGRESS.md` and `docs/STABILITY_REVIEW_2026-10-27.md` before reading index contents. Release preparation copies `encrypted-backup.mjs` and `portable-export.mjs`, and the release check requires both files.

Commands run with Node 24.22.1:

| Profile | Result | Evidence |
| --- | --- | --- |
| `npm run test:fast` | PASS | Build, artifact validation, finance, budget, statement reconciliation, split/reimbursement, and commitment checks exited 0. |
| `npm run test:integration` | PASS | Build, HTTP checks, SQLite, backup/recovery, runtime status, and portable export checks exited 0. |
| `npm run test:browser` | PASS | Broad Playwright/Axe acceptance, all 16 registered product cases, and injected page/expectation harness checks exited 0. Two stale budget editor interactions were repaired after the first run exposed them. |
| `npm run test:fast` (after runner changes) | PASS | Candidate digest remained stable across build and all focused suites exited 0. |
| `npm run test:recovery` with an isolated Ubuntu `age` package | PASS | Synthetic SQLite backup was encrypted through the real `tar`/`age` pipeline, restored, integrity checked, and checked against wrong-key and corrupted-ciphertext failures. The package was extracted under `/tmp`, not installed system-wide. |
| `npm run test:release` | PASS | Disposable source snapshot excluded protected docs/private paths, committed in a temporary Git repository, packaged immutably, and exercised importer, backup, restore, portable export, encrypted CLI fail-closed behavior, server health, checksums, and rollback. |
| Source scan harness | PASS | An untracked synthetic key canary was detected without printing its contents. |
| SQLite transaction split route | PASS | Real SQLite operation replay survived a fresh repository connection; stale revision was rejected. |
| `npm run test:ci` on the final candidate | PASS | Fast, integration, encrypted recovery, browser acceptance plus all 16 product cases and harness checks, source scan/canary, and disposable release rehearsal all passed sequentially. Candidate digest was stable during each profile. |
| `npm run test:extended` | PASS | 10k/100k synthetic performance and operation storage/growth measurements completed. Measurements are informational; no hardware-specific regression thresholds exist yet. |

The release profile requires an immutable release directory and reports BLOCKED when one is not supplied. The source scanner reads modified and untracked candidate files while excluding both protected documents before reads. `npm run check` now aliases the complete local CI profile; a required missing tool or browser is nonzero and explicitly BLOCKED.

## Remaining work

T00 hashes permitted candidate inputs and verifies they remain unchanged during a profile. T01 includes a clean environment, private temporary HOME/TMP, explicit browser cache, and process-group timeout cleanup; network isolation and wider fault injection remain. T02 emits structured JSON with PASS/FAIL/BLOCKED/NOT_RUN and candidate hashes; JUnit output remains. T03 page-error self-check uses the same error assertion as successful cases; broader API/console/startup/cleanup fault injection remains. T04 real `age` round trip and immutable release rehearsal pass on this synthetic candidate. T05 has deterministic generated exact-cent split invariants; targeted source mutations and broader generated date/money tests remain. T06 adds real SQLite route replay/restart for splits; other new route families still need equivalent persistence/concurrency coverage. T07 includes working-tree secret-canary scanning and packaged portable export; concurrent snapshot and full unauthorized/error-path probes remain. T08 all existing browser cases pass, but ten-run flake qualification and manual assistive-technology checks remain. T09 adds GitHub Actions gates for fast, integration, recovery, browser, release, and scheduled extended checks. GitHub branch protection is an administrative setting and remains unverified; Jetson ARM64 validation and measured platform performance thresholds remain.

Do not treat the current `test:release` alias as immutable package acceptance: it currently runs only the source scanner. It is a temporary profile stub until T04/T09 provide a disposable release rehearsal with an explicit candidate identity and release directory.
