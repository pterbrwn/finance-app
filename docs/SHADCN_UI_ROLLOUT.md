# shadcn UI rollout

This document records the additive React/Vite + shadcn/ui frontend in `ledger-ui/`.

## Design boundary

- The existing Node server, SQLite repository, backup scripts, API routes, financial calculations, and the vanilla UI remain authoritative.
- `ledger-ui/` uses the same `/api` surface, integer-cent values, replay-safe write protocol, and household profile rules.
- No dark mode, remote fonts, external assets, telemetry, or browser database/cache are introduced.
- Production activation is deliberately deferred. The original UI continues to be served at `/`.

## Current integration

- `npm run check:react-ui` runs lint, typecheck, and build for the parallel app.
- `npm run build:react-ui` runs the parent build with `LEDGER_UI_MODE=react`. The generated server embeds Vite's hashed assets and exposes the React app at `/react`.
- `LEDGER_UI_CUTOVER=1` is an explicit opt-in to serve the React app at `/`. It must not be used for a release until the full existing browser and release gates have been rerun.

## Gate order before any cutover

1. `npm run check:react-ui`
2. `npm run test:ci`
3. `npm run check:local-http`
4. `npm run check:source`
5. `npm run check:browser:harness`
6. A disposable release rehearsal with `LEDGER_UI_MODE=react`
7. Operator review, then a separate immutable release and activation

Human-only checks remain physical screen-reader use, physical 200% zoom, real Tailscale identity verification, off-device encrypted restore, and live Plaid credential validation where applicable.
