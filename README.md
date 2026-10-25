# Ledger personal finance

A personal finance dashboard hosted on a Jetson. Source code lives at https://github.com/pterbrwn/finance-app. GitHub contains code and synthetic test fixtures only.

## Privacy and access

- Financial records are stored on the Jetson in `~/.local/state/ledger/state.json`, outside the repository. Its directory has permissions `700` and the file has permissions `600`.
- Credentials and the bank token encryption key live in `~/.config/ledger/config.json` with permissions `600`. Never paste them into chat, a GitHub issue, or source code.
- The Jetson service listens only on `127.0.0.1:3001` (the development default is port 3000). Tailscale Serve provides a private HTTPS address for remote access. The configured Tailscale owner is required; other tailnet identities and anonymous requests are rejected.
- Remote access requires Tailscale on the client. Do not enable Tailscale Funnel, public port forwarding, or public hosting. Tailscale HTTPS certificate names appear in public certificate transparency logs; financial content remains private.
- Plaid may process bank data when enabled. Ledger's database, bank tokens, and credentials remain on the Jetson; no Sites, R2, GitHub, or cloud job stores them.
- Viewing the dashboard sends records to your authenticated browser. Responses use `Cache-Control: no-store`; there is no browser database or transaction cache. Export CSV explicitly downloads records to the device running your browser.
- With bank integration disabled or unconfigured, browser policy blocks external scripts, frames, and network connections. The app includes no analytics, remote fonts, or external assets.

## Run locally

Requires Node 20.11+ and Bash. There are no npm dependencies to install.

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
cp deploy/ledger*.service deploy/ledger-sync.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable ledger.service
systemctl --user restart ledger.service
```

Use `systemctl --user status ledger.service` and `journalctl --user -u ledger.service` to inspect it. To keep user services running after SSH logout and at boot, enable lingering for your user with `loginctl enable-linger "$USER"` if permitted by the host.

All server start paths use the same non-blocking `flock` under the private data directory, so a second process cannot write the JSON state concurrently. Financial state is written atomically and updates are serialized within the process as well. The user timer talks to the running service and never starts another writer. Check `/api/health` for the code/schema version and safe readiness status. Back up the private state and matching configuration/key locally before upgrades; backups must stay outside Git. To roll code back, activate a previously prepared release and restart the service; database/schema rollback also requires a compatible backup and migration plan.

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

The updater skips unconfigured or unconnected banks. A sync failure exits unsuccessfully without printing financial records or credentials. Persistent timers catch up after downtime. The Jetson must be powered on and online to fetch bank data. This polls existing Plaid data and does not call the potentially billable Transactions Refresh endpoint.

## CSV import

Use Transactions or Banks & accounts → Import CSV. Required columns: `Date`, `Merchant`, `Amount`. Dates are YYYY-MM-DD; positive amounts are spending, negative amounts are credits. Optional: `Category`, `Currency` (USD), `Status` (Posted or Pending). Limits: 1 MB, 5,000 transactions per file.

Synthetic example:

```csv
Date,Merchant,Amount,Category,Currency,Status
2026-10-20,Example Grocery,42.50,Groceries,USD,Posted
2026-10-21,Example Payroll,-2500.00,Income,USD,Posted
```

The same file imported into the same account is idempotent. Overlapping or modified files are not reconciled with each other or Plaid. Keep CSV accounts separate from accounts synced for the same dates. Native bank formats may need column and amount-sign conversion.

## Financial behavior

Amounts use integer cents. Pending transactions and non-USD currencies are excluded from totals. Transfers and credit card payments are excluded from spending; refunds reduce category spending. Income less spending is net cash flow, not change in account balance. Budget limits recur monthly without rollover.

Plaid sync collects pagination before committing, restarts after pagination mutations, handles added/modified/removed transactions, and preserves category overrides when pending transactions post. Access tokens use AES-256-GCM with random nonces and are never returned to the browser. Disconnect revokes the Plaid Item and removes that bank's records; manual CSV accounts remain separate.

## Checks and source control

```sh
npm run check
npm run check:local-http
npm run check:source
```

The HTTP suite uses disposable synthetic data and tests imports, restart persistence, permissions, Host/Origin protections, Tailscale identity checks, and local-only mode. It does not load your private config or production records.

The repository ignores local config, runtime state, bank exports, databases, logs, certificates, generated builds, and hosting metadata. Install [Gitleaks](https://github.com/gitleaks/gitleaks), ensure it is on PATH, and enable the included hooks:

```sh
git config core.hooksPath .githooks
```

Pre-commit checks inspect staged content, reject private/generated paths even if force-added, and scan staged changes for secrets. Pre-push scans Git history. Hooks fail if Gitleaks is unavailable. Only `config.example.json` with blank credentials belongs in Git.

Application files: `worker/index.js` (API and finance logic), `ui/browser.js`, `ui/styles.css`, `scripts/dev-server.mjs` (loopback HTTP adapter), and `scripts/runtime.mjs` (private local configuration). `dist/` is generated from source and has no cloud deployment manifest.
