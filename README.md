# Ledger personal finance

A personal finance dashboard hosted on a Jetson. Source code lives at https://github.com/pterbrwn/finance-app. GitHub contains code and synthetic test fixtures only.

## Current operational build

The private service runs release `122f014` on Node.js 24.22.1 with SQLite schema 3. The existing JSON state was imported and reconciled before activation; its paired JSON/config recovery copy remains private on the Jetson. The verified daily SQLite backup timer is active. The bank sync timer remains disabled. Existing provider records without a saved environment are blocked from sync until that environment is independently verified; manual entry and CSV import remain available.

## Privacy and access

- Financial records are stored on the Jetson under `~/.local/state/ledger/`, outside the repository. The current service uses SQLite; a checksummed pre-migration JSON/config pair is retained in a private recovery directory. Directories use permissions `700` and private files use `600`.
- Credentials and the bank token encryption key live in `~/.config/ledger/config.json` with permissions `600`. Never paste them into chat, a GitHub issue, or source code.
- The Jetson service listens only on `127.0.0.1:3001` (the development default is port 3000). Tailscale Serve provides a private HTTPS address for remote access. The configured Tailscale owner is required; other tailnet identities and anonymous requests are rejected.
- Remote access requires Tailscale on the client. Do not enable Tailscale Funnel, public port forwarding, or public hosting. Tailscale HTTPS certificate names appear in public certificate transparency logs; financial content remains private.
- Plaid may process bank data when enabled. Ledger's database, bank tokens, and credentials remain on the Jetson; no Sites, R2, GitHub, or cloud job stores them.
- Viewing the dashboard sends records to your authenticated browser. Responses use `Cache-Control: no-store`; there is no browser database or transaction cache. Export CSV explicitly downloads records to the device running your browser.
- With bank integration disabled or unconfigured, browser policy blocks external scripts, frames, and network connections. The app includes no analytics, remote fonts, or external assets.

## Run locally

Requires the pinned Node.js 24.22.1 runtime and Bash. Install the app-specific runtime once with `scripts/install-node-runtime.sh`; it does not replace the system Node installation. The pinned SQLite and decimal dependencies are installed into each immutable release from the lockfile.

```sh
npm run setup:local
npm start
```

Open `http://127.0.0.1:3000` on the Jetson. Use `npm run setup:local -- --enable-plaid` on first setup if Plaid processing is desired. Setup preserves an existing configuration and encryption key. Enable an existing configuration by editing `enablePlaid` privately.

For remote access, configure `publicOrigin` with the exact Tailscale HTTPS origin (no trailing slash) and `tailscaleLogin` with your Tailscale owner login in the private config. Then configure a private Serve proxy:

```sh
tailscale serve --bg http://127.0.0.1:3001
```

The app must run on the Jetson, and both devices must be connected to Tailscale. Local loopback access also remains available. Do not put your private origin or login in `config.example.json`.

## Jetson service

The application uses the pinned Node 24.22.1 ARM64 runtime in `~/.local/share/ledger/runtimes/`, separate from the system Node installation. The service units point to an immutable release through `~/.local/share/ledger/current`; prepare releases from committed source and validate them before changing this symlink.

```sh
scripts/install-node-runtime.sh
scripts/prepare-release.sh "$(git rev-parse --short=12 HEAD)"
scripts/activate-release.sh "$(git rev-parse --short=12 HEAD)"
mkdir -p ~/.config/systemd/user
cp deploy/ledger.service deploy/ledger-backup.service deploy/ledger-backup.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable ledger.service
systemctl --user enable --now ledger-backup.timer
systemctl --user restart ledger.service
# Keep ledger-sync.timer disabled until live sync and recovery are verified.
```

Use `systemctl --user status ledger.service` and `journalctl --user -u ledger.service` to inspect it. To keep user services running after SSH logout and at boot, enable lingering for your user with `loginctl enable-linger "$USER"` if permitted by the host.

All server start paths use the same non-blocking `flock` under the private data directory, so a second process cannot write the active SQLite database concurrently. Financial state is written atomically and updates are serialized within the process as well. The bank sync timer talks to the running service and never starts another writer. Check `/api/health` for the code/schema version and safe readiness status. Back up the private state and matching configuration/key locally before upgrades; backups must stay outside Git. To roll code back, activate a previously prepared release and restart the service; database/schema rollback also requires a compatible backup and migration plan.

### SQLite state and recovery

The deployed SQLite schema and repository use WAL, foreign keys, bounded write transactions, and the SQLite online backup API. The legacy importer checked encrypted tokens with the existing key, preserved record identities and payloads, and recorded a source checksum. A private paired JSON/config backup and a verified SQLite backup/restore rehearsal were completed before activation; the original JSON remains available as a pre-cutover recovery copy. New writes go to SQLite. Do not replace a newer database with that older JSON snapshot. Items without saved provider environment metadata remain blocked from sync until their environment is verified. The 3:00 AM local backup timer is active and the first systemd backup succeeded. The bank sync timer remains disabled.

## Connect banks

1. Create a [Plaid developer account](https://dashboard.plaid.com/signup) and enable Transactions. Start with Sandbox. Trial/Production access and pricing depend on your Plaid account.
2. In the Jetson's private config, set `enablePlaid` to `true`, fill `plaidClientId` and `plaidSecret`, and keep `plaidEnv` as `sandbox`. Setup generates `tokenEncryptionKey`; preserve it while accounts are connected.
3. Leave `plaidRedirectUri` blank to use Plaid's desktop popup flow. If a redirect is needed, set it to the private Tailscale HTTPS origin with a trailing slash and register that exact URI in Plaid's dashboard first. See [Plaid OAuth documentation](https://plaid.com/docs/link/oauth/). No public application endpoint is needed.
4. Restart `ledger.service`. In Banks & accounts, connect a Sandbox test account and verify repeat syncs do not duplicate transactions.
5. For real accounts, configure eligible Production credentials and authorize the exact LMCU and Chase institutions in Link. Confirm balances, transaction dates, categories, reconnect, and duplicate prevention. Bank availability must be verified through the actual connection flow.
6. After a successful live connection and manual unattended sync, activate the local timer below.

Live bank validation needs your credentials and authorization; automated checks mock Plaid and cannot prove bank connectivity. Rotating the encryption key requires reconnecting accounts or re-encrypting stored tokens.

## Daily updates

The supplied `ledger-sync.timer` runs at **6:00 AM America/Chicago**, on the Jetson. It is installed but must remain disabled until live sync succeeds. It uses the running loopback server, so it never opens a second writer or stores credentials in a cloud automation.

```sh
systemctl --user start ledger-sync.service
# After verifying a successful live update:
systemctl --user enable --now ledger-sync.timer
systemctl --user list-timers ledger-sync.timer
```

The updater skips unconfigured or unconnected providers. Sync requests create or join a persisted job, and the updater polls that job until it finishes. A sync failure exits unsuccessfully without printing financial records or credentials. Persistent timers catch up after downtime. The Jetson must be powered on and online to fetch bank data. This polls existing Plaid data and does not call the potentially billable Transactions Refresh endpoint. Settings reports the actual user systemd timer state and the latest job status.

## CSV import

Use Transactions or Accounts → Import CSV. The preview lets you map date, merchant, amount, and category columns; choose ISO, US, or day-first dates; and set the spending sign convention. Unknown categories must be mapped before commit. Rows are shape and quote validated, limited to 1 MB and 5,000 transactions, and USD only. Matching date/merchant/amount rows are shown for review and are never silently merged; identical real purchases can be kept. Exact file reimports are skipped. A committed batch can be undone from the preview dialog.

Synthetic example:

```csv
Date,Merchant,Amount,Category,Currency,Status
2026-10-20,Example Grocery,42.50,Groceries,USD,Posted
2026-10-21,Example Payroll,-2500.00,Income,USD,Posted
```

The same exact file imported into the same account is idempotent. Overlapping or modified files require review and can create separate transactions; they are not reconciled with Plaid. Keep CSV accounts separate from accounts synced for the same dates unless you explicitly reconcile them. Formula-like text is escaped only in exported CSV and stored merchant/category values are unchanged.

## Dashboard states and navigation

The dashboard starts with your actual saved state, including an honest empty view for new accounts. Sample data appears only after you choose **Explore sample data** or **Open sample preview**, and the preview has an always-visible exit action. Loading failures show an error without substituting example balances. A failed refresh keeps the last loaded records visible with a stale/error notice. The Overview, Transactions, Budgets, Accounts, Investments, Goals, Home planner, and Settings pages are addressable with `?page=...`; month, search, category, account, date, review, and page filters are kept in the URL for links and browser history. Transactions are returned in stable server ordered pages. On narrow screens the navigation scrolls horizontally while keeping every destination reachable.

Overview separates actual balance-sheet values from spending and planning. It reconciles linked mortgage liabilities once, does not add holdings or goals on top of their accounts, and identifies stale, missing, excluded, and non-USD records. Daily balance history starts only when you record a local snapshot; no earlier net-worth values are inferred. Month-over-month spending follows the same refund and pending-transaction rules as the rest of the dashboard.

Saved home scenarios are hypothetical and versioned. They separate P&I from total ownership outflow, show cash to close and reserves, and use explicit quote dates and sources. Escrow, credits, earnest already paid, maintenance, rent replacement, current commitments, and optional linked goal funding are handled separately. Rate, cost, maintenance, and income sensitivities are estimates, not approval decisions. Scenarios affect goals or the Housing budget only after a separate confirmation.

The Home planner records owned properties and mortgage or lien statements. Values and statement balances are dated observations; amortization forecasts remain separate. Fixed-rate projections use monthly Decimal calculations with cent rounding and extra-principal comparisons. Unsupported loan types do not receive a misleading schedule. Linked liabilities can only be attached once, and partial property ownership requires an explicit share of each loan. Property addresses are stored locally and are not used for lookup.

Goals earmarks eligible cash without moving money or adding assets. New allocations use fresh included USD depository balances, conservatively capped by available balance; stale snapshots are provisional, and investment, retirement, HSA, credit, archived, and unknown-balance accounts cannot back new allocations. If balances later fall below saved allocations, Goals keeps the history and shows the verified shortfall. Funding priority is deterministic. Projections assume zero return unless an explicitly dated cash APY is entered; month-end contribution dates are shown by the calculation.

Budgets supports custom expense buckets with optional monthly limits. A custom bucket has a stable ID, can be renamed/reordered/archived, and remains attached to historical assignments when its display name changes. Income and Transfers remain protected system categories. Edits send an expected revision so a stale tab receives a conflict and can reload instead of silently replacing a newer change.

## Financial behavior

Amounts use integer cents. Pending transactions and non-USD currencies are excluded from totals. Transfers and credit card payments are excluded from spending; refunds reduce category spending. Income less spending is net cash flow, not change in account balance. Budget templates take effect from a selected month; a month override is separate, and resetting it returns to the effective template. Blank means no limit; zero is a deliberate zero-dollar limit. Legacy budgets have no invented history before the migration month.

Plaid sync collects pagination before committing, restarts after pagination mutations, handles added/modified/removed transactions, and preserves category overrides when pending transactions post. Access tokens use AES-256-GCM with random nonces and are never returned to the browser. Unlink revokes the Plaid Item and retains its local accounts, transactions, and holdings; deleting that connection's history is a separate explicit action. Manual CSV accounts remain separate.

## Checks and source control

For the current testing handoff, use the [automated testing execution plan](docs/AUTOMATED_TESTING_PLAN.md) and [browser acceptance playbook](docs/AGENT_BROWSER_REPAIR_PLAN.md). The transaction-save repair and budget plan-versus-actual implementation are in the current release candidate, with the verified coverage and remaining acceptance gaps recorded in [CURRENT_STATE_REPORT.md](docs/CURRENT_STATE_REPORT.md).

The [budget plan-versus-actual update plan](docs/BUDGET_PLAN_VS_ACTUAL_PLAN.md) records the original requirements and acceptance cases for compact rows, projected income, running bucket deductions, actual results, and month-end outlook. The implementation is now available in Budgets; the plan's remaining test cases are still useful for manual acceptance.

```sh
npm run check
npm run check:local-http
npm run check:source
```

The HTTP suite uses disposable synthetic data and tests imports, restart persistence, permissions, Host/Origin protections, Tailscale identity checks, and local-only mode. It does not load your private config or production records.

Automated browser acceptance covers 1440, 390, and 320 CSS px, keyboard workflows, dialogs, chart data alternatives, and a 720 CSS px zoom proxy. The owner accepted the manual accessibility item for this deployment; headless automation does not emulate a screen reader or actual 200% browser zoom.

The repository ignores local config, runtime state, bank exports, databases, logs, certificates, generated builds, and hosting metadata. Install [Gitleaks](https://github.com/gitleaks/gitleaks), ensure it is on PATH, and enable the included hooks:

```sh
git config core.hooksPath .githooks
```

Pre-commit checks inspect staged content, reject private/generated paths even if force-added, and scan staged changes for secrets. Pre-push scans Git history. Hooks fail if Gitleaks is unavailable. Only `config.example.json` with blank credentials belongs in Git.

Application files: `worker/index.js` (API routes), `server/repository.mjs` (state repository boundary), `shared/` (financial and reconciliation rules), `ui/browser.js`, `ui/styles.css`, `scripts/dev-server.mjs` (loopback HTTP adapter), and `scripts/runtime.mjs` (private local configuration). The HTML shell loads only allowlisted static assets from `/assets/app.js` and `/assets/styles.css`; `dist/` is generated from source and has no cloud deployment manifest.
