# Finance app implementation progress

Code-only log. No production records, account names, credentials, private origins, or balances belong here.

## T00 — Safe implementation baseline

**Status:** Complete. Source baseline, synthetic test baseline, and private backup/restore rehearsal are recorded.

- Baseline commit: `9e5428d`.
- Implementation branch: `codex/finance-app-plan`.
- Existing uncommitted changes in `worker/index.js` contain partial investment, holdings, custom-category, and manual-account behavior. Preserved in the working tree; reviewed as incomplete and not deployed.
- Ran `npm run check` in a disposable source-only copy: build, artifact validation, finance checks, and local storage checks passed.
- Ran `npm run check:local-http` in a disposable source-only copy: local server, access guards, synthetic CSV import, concurrency, and restart persistence checks passed.
- The running `ledger.service` uses `/usr/bin/node scripts/dev-server.mjs` from the checkout and is active; `ledger-sync.timer` is inactive. The installed runtime is Node 20.20.2 on ARM64.
- The service has no version health endpoint. Its current generated artifact predates T01 and has no version metadata; the review records the deployed baseline as `9e5428d`.
- Created a private paired backup of the production JSON state and config/key, mode `700` directory and `600` files, with a checksum-only manifest. Copied it to an isolated restore directory, parsed both files, decrypted every stored token with the paired backup key, and removed the temporary restore copy. The active service was not interrupted.

## T01 — Pending-to-posted reconciliation

**Status:** Complete. Commit: `e4e1258`.

- Added `applySyncPages` to aggregate all page additions, modifications, and removals before applying the update, preserving overrides when a pending transaction is removed on one page and its posted replacement arrives on another.
- Added regression coverage for both page orders.
- Ran the focused regression check and the full finance and isolated HTTP suites; all passed.

## T02 — Safe runtime and release operations

**Status:** Complete. Commit: `6b411d9`.

- Installed Node.js `24.22.1` in the application-owned runtime directory after verifying the official ARM64 archive checksum. `/usr/bin/node` remains unchanged.
- Added an application startup wrapper that holds a non-blocking `flock` for the data directory; direct server starts fail unless launched through that wrapper. The sync timer uses the pinned runtime and talks to the active service.
- Added build/schema health metadata, immutable release preparation from committed Git source, and atomic activate/rollback symlink scripts. Updated service units to use the current release path; they have not been installed or activated.
- Finance, artifact, storage, and HTTP suites passed in a disposable source-only copy under Node 24, including a second-writer rejection check.
- Prepared and launched a release in a synthetic environment, confirmed the health code version, activated and rolled back symlinks, and confirmed an invalid release leaves the active synthetic symlink intact.

## Existing unfinished patch

**Status:** Preserved on the implementation branch as a separate review unit. Commit: `6d31831`.

- The commit contains the pre-existing partial investment, holdings, custom-category, and manual-account changes from `worker/index.js`.
- The review confirms the patch lacks complete UI, stable account/category identities, and feature-specific coverage. It remains an implementation input for T09 and has not been activated.

## T03 — Modularize without redesigning behavior

**Status:** Complete. Commit: `fcc847a`.

- Extracted pure money, reporting, investment-account, holdings, transaction-reconciliation, and storage-repository modules.
- Built the standalone output as an ESM module tree instead of concatenated source. The local runtime now depends on the repository interface rather than the bucket adapter.
- Moved browser code and styles to a strict static asset allowlist. The HTML shell has no inline script, script CSP no longer permits inline code, and traversal requests return 404.
- Finance, storage, API, client-render, static-route, access-control, concurrency, and HTTP checks passed under Node 24 in an isolated source copy.
- Prepared and launched a synthetic release, confirmed versioned health and static assets, and verified activation, rollback, and failed-activation preservation.

## T04a — SQLite adapter and recovery commands

**Status:** Complete. Commit recorded below after verification.

- Verified `better-sqlite3@13.0.3` loads and executes SQLite 3.53.4 on the host's Linux ARM64 / Ubuntu 22.04 / GLIBC 2.35 environment under pinned Node 24.22.1. `decimal.js@10.6.0` and the lockfile are pinned.
- Added schema migration 001, a local SQLite repository with foreign keys, WAL, 5-second busy timeout, atomic state writes, normalized record tables, and a configuration-selected adapter. JSON remains the active default until migration gates are explicitly completed.
- Added SQLite online backup and verified restore commands. Release preparation installs production dependencies from the committed lockfile into each immutable release.
- Tested constraint failure rollback, integrity and foreign-key checks, backup API output and permissions, and restore in a disposable synthetic directory.
- Full finance, storage, artifact, SQLite, and isolated HTTP checks passed in a disposable source-only copy under Node 24.

**Next:** T04b, explicit legacy JSON importer and checksum/idempotency validation. Production remains on JSON until golden-data comparison and rollback gates pass.
