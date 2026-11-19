# Ledger UI

Parallel React/Vite + shadcn/ui frontend for the existing finance app. It talks to the same local `/api` endpoints as the original interface and does not change financial logic, SQLite storage, backups, or API behavior.

By default the Node server still serves the original vanilla UI at `/`. This app is additive: an opt-in build exposes it at `/react` while `/` remains unchanged. Production cutover is a separate, human-controlled release step.

## Run against a local Ledger server

Use the pinned Node runtime and start the existing local server first:

```sh
cd ~/Development/finance-app
export PATH="$HOME/.local/share/ledger/runtimes/node-v24.22.1/bin:$PATH"
npm ci
npm start
```

Then, in a second terminal:

```sh
cd ~/Development/finance-app/ledger-ui
export PATH="$HOME/.local/share/ledger/runtimes/node-v24.22.1/bin:$PATH"
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The Vite dev server proxies `/api` to `http://127.0.0.1:3000` and rewrites the proxy `Origin` so the existing local adapter accepts the request. Set `LEDGER_DEV_API` if the local server uses a different origin.

To open the synthetic interface preview without saved data, use `http://127.0.0.1:5173/?preview=true`. Preview mode blocks every write and labels all figures as generated locally.

## Checks

```sh
npm --prefix ledger-ui run lint
npm --prefix ledger-ui run typecheck
npm --prefix ledger-ui run build
```

From the parent project, the equivalent shortcut is:

```sh
npm run check:react-ui
```

## Opt-in server build

The parent build script can embed this app into the strict local asset map without replacing the current interface:

```sh
cd ~/Development/finance-app
npm run build:react-ui
```

This produces a standalone server where:

- `/` still serves the original vanilla UI.
- `/react` serves the React/shadcn UI.
- Hashed JS/CSS, the local Inter font files, and `/ledger.svg` are served only from the embedded allowlist.
- Security headers, `Cache-Control: no-store`, and the local-only CSP are unchanged.

`LEDGER_UI_CUTOVER=1` would serve the React UI at `/` as well. That is intentionally not used by default and requires the full existing browser/release gates plus an operator decision.

## Scope

- Light-only shadcn theme mapped from the parent `DESIGN.md`; no dark mode, remote fonts, telemetry, or external assets.
- Responsive sidebar, mobile quick navigation, page selector, and household profile state backed by the URL.
- Overview, Transactions with review/rules/import/export, Budgets, Bills, Accounts, Investments, Goals, Home planner, and Settings.
- Same-origin API client with replay-safe write ids, pending-operation recovery, revision checks, and error/status handling.
- All money is handled as integer cents in the browser and formatted only at the edge.

The React app is not activated in production by these steps. Activation remains a separate release operation.
