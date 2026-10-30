# Household profiles handoff

> **Current implementation acceptance: COMPLETE (synthetic/local).** R12–R18 fixes passed full CI on Node v24.22.1, candidate SHA-256 `fede122971ef6635548e5d7de2a7771d22f1764fafb8c0c619a458eaf58bde88` (115 files). The feature has not been deployed or reconciled against live household data.

The household profile feature is implemented and passes the local synthetic CI and release checks, but it has not been deployed or validated against live household data. No live database, Tailscale member list, credentials, or sync schedule was changed. Both household members have access to all financial profiles; Peter/Maddie selectors separate reporting and budgets, not permissions or privacy.

## Current behavior

- The top-level selector offers exactly Combined Budget, Peter, and Maddie. Combined is the household view; Joint is an ownership label, not an extra copy of household totals. Combined Transactions includes an owner filter for Peter, Maddie, and Joint; Joint remains available for shared plan edits inside Combined.
- Accounts and properties have an owner. Transaction attribution defaults to its explicit owner override or its account owner. A salary deposited into a Joint account can be attributed to Peter without moving or duplicating the account balance.
- New provider accounts remain unresolved until assigned. Unresolved accounts and transactions remain in Combined with an ownership review subtotal and are omitted from Peter/Maddie/Joint personal views.
- Budgets, projected income, and outlooks are scoped by profile. Combined Budget shows Peter/Maddie/Joint plan amounts and household totals. The owner-labeled edit buttons switch to the selected owner's plan before editing.
- Custom budget categories have an owner, stable ID, and profile-scoped name uniqueness. Identical names can be used in Peter's and Maddie's plans without merging their editable records.
- Mortgages inherit the property's owner. Investment holdings inherit the investment account unless explicitly overridden; the override and actor history survive provider refresh. This affects personal holdings lists, while account balances remain counted once at account owner. The dashboard does not allocate a provider account valuation across mixed-owner positions. Affected personal balance sheets are explicitly marked incomplete until a supported allocation is available; Combined still counts the provider account once.
- New balance snapshots store the selected view profile and the `current-profile-ownership-v1` attribution policy. Older snapshots remain as legacy records without inferred personal attribution.
- Legacy accounts/plans are provisionally attributed to Peter by migration. Review those classifications before relying on personal reports. Joint and Maddie start without guessed legacy records.

## Configure household access

The runtime reads the private configuration file, not a checked-in source file. To admit a second Tailscale identity, add it to `tailscaleMembers` in that private config after confirming the exact login from Tailscale. The schema is:

```json
{
  "tailscaleMembers": [
    { "login": "existing-owner-login", "actorId": "peter-actor" },
    { "login": "confirmed-second-login", "actorId": "maddie-actor" }
  ]
}
```

Use the actual Tailscale login strings and distinct stable actor IDs. The names above are examples, not configured identities. Existing `tailscaleLogin` remains supported and maps to `local-owner`; do not configure duplicate logins or actor IDs. For the public Tailscale route, retain the exact HTTPS `.ts.net` `publicOrigin` required by runtime validation. The local proxy maps trusted Tailscale headers to configured actor IDs and overwrites client-supplied identity headers. Do not add a profile selector as an authorization rule.

Both allowed actors can view and edit Peter, Maddie, and Joint records. If private budgets are needed, pause before using this design for sensitive separation; per-person authorization is not part of this feature.

## Migration and ownership review

The new SQLite schema is version 9. Opening an older supported database with the new runtime performs migrations and records a migration backup. No production migration has been run. Before activation:

1. Make and verify a complete private recovery bundle using the existing backup procedure.
2. Confirm the exact owner logins and `publicOrigin` in the private runtime configuration; do not put them in source control.
3. On a reviewed copy, verify legacy account and budget attribution, assign Maddie/Joint where appropriate, and compare Combined totals before and after. Preserve unresolved classifications for records that cannot be confirmed.
4. Review account ownership before trusting Peter/Maddie balance sheets. Review transaction overrides for salary and shared-account activity. Review each property and linked mortgage.
5. If rollback is needed after migration, restore the complete pre-migration recovery bundle with the compatible runtime. Do not point older code at the migrated database or attempt a symlink-only downgrade.

Account ownership changes show a preview of inherited and explicitly overridden transactions and holdings. The server blocks moves that would leave known savings-goal, commitment, or mortgage links under an incompatible profile, pins the preview revision, records an audit history, and offers guarded undo. Compatible linked goals, commitments, scenarios, properties, and mortgages can be reassigned together after explicit confirmation; incompatible dependencies fail closed. Preview and mutation validation use the complete SQLite relationship state. Goal-allocation undo revalidates current ownership and available cash. Provider refresh preserves ownership history and edit versions, so a balance refresh alone does not invalidate a safe ownership undo. Property owner changes are checked against linked liability accounts. Goal cash allocations, commitment matches, scenario links, and reimbursements have cross-profile validation. Manually review investments and all related links before changing owners. Keep an audit copy of pre-change ownership and household totals.

## Verification and rollout limits

`PATH=/tmp/ledger-age-check/extracted/usr/bin:$PATH npm run test:ci` passed on source candidate SHA-256 `fede122971ef6635548e5d7de2a7771d22f1764fafb8c0c619a458eaf58bde88` (115 files): fast, integration, recovery, broad browser acceptance, all 22 isolated browser cases, and release rehearsal. Focused SQLite and finance regressions passed, including all-profile plan preservation across full-state save/reopen, safe modern-v9 reopen, same-name Peter/Maddie CSV accounts, category rename/reopen, SQLite migration interruption/retry, valid matched-commitment reassignment, incompatible allocation undo and its UI conflict path, and provider-refresh audit preservation with safe undo. Encrypted recovery used an isolated `age` binary under `/tmp`; the host was not modified. Mixed brokerage attribution is disclosed as incomplete because provider data does not support a trustworthy personal valuation allocation; Combined counts the account once. Legacy snapshots remain unattributed. Prevention does not recreate any Maddie/Joint plans or audit history already lost; compare a private recovery copy against authoritative backups/history during rollout and reconcile known gaps. See [HOUSEHOLD_PROFILES_EXECUTION.md](HOUSEHOLD_PROFILES_EXECUTION.md) and [HOUSEHOLD_PROFILES_PLAN_LUNA_HIGH.md](HOUSEHOLD_PROFILES_PLAN_LUNA_HIGH.md) for evidence and remaining rollout steps.

No deployment is included. Production activation, migration/restore rehearsal, actual Maddie login testing, existing-record ownership review, and post-activation reconciliation are still outstanding. Bank sync scheduling remains unchanged.
