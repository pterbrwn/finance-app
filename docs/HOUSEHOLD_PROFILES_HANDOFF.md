# Household profiles handoff

> **Production status: DEPLOYED, existing ownership confirmed.** Release `5f77f24` (commit `5f77f242dc294f0a268670879d4ba6585042f3d9`) is active on Node v24.22.1 with SQLite schema 9. GitHub Actions run [41104471966](https://github.com/pterbrwn/finance-app/actions/runs/41104471966) passed. Peter confirmed all existing records belong to him; the ownership-review marker was cleared and audit-stamped. The private recovery bundle was verified and restored to a disposable directory; schema migration preserved all 15 accounts, 2,282 transactions, and 42 holdings with no integrity or foreign-key errors.

The household profile feature is deployed. All existing accounts, budgets, and categories are Peter-owned; existing transactions and holdings inherit Peter through their accounts. Production has 15 accounts, 2,282 transactions, 42 holdings, 16 budget records, and 22 custom categories. SQLite integrity and foreign-key checks pass. No Tailscale member, credential, or sync schedule has been changed. The current private configuration has no additional household actor configured, so Maddie does not yet have a separate Tailscale login. Both household members can access all profiles once authorized; Peter/Maddie selectors separate reporting and budgets, not permissions or privacy.

## Current behavior

- The top-level selector offers exactly Combined Budget, Peter, and Maddie. Combined is the household view; Joint is an ownership label, not an extra copy of household totals. Combined Transactions includes an owner filter for Peter, Maddie, and Joint; Joint remains available for shared plan edits inside Combined.
- Accounts and properties have an owner. Transaction attribution defaults to its explicit owner override or its account owner. A salary deposited into a Joint account can be attributed to Peter without moving or duplicating the account balance.
- New provider accounts remain unresolved until assigned. Unresolved accounts and transactions remain in Combined with an ownership review subtotal and are omitted from Peter/Maddie/Joint personal views.
- Budgets, projected income, and outlooks are scoped by profile. Combined Budget shows Peter/Maddie/Joint plan amounts and household totals. The owner-labeled edit buttons switch to the selected owner's plan before editing.
- Custom budget categories have an owner, stable ID, and profile-scoped name uniqueness. Identical names can be used in Peter's and Maddie's plans without merging their editable records.
- Mortgages inherit the property's owner. Investment holdings inherit the investment account unless explicitly overridden; the override and actor history survive provider refresh. This affects personal holdings lists, while account balances remain counted once at account owner. The dashboard does not allocate a provider account valuation across mixed-owner positions. Affected personal balance sheets are explicitly marked incomplete until a supported allocation is available; Combined still counts the provider account once.
- New balance snapshots store the selected view profile and the `current-profile-ownership-v1` attribution policy. Older snapshots remain as legacy records without inferred personal attribution.
- Legacy accounts/plans were attributed to Peter by migration, as Peter confirmed. The production ownership-review marker has been cleared and audit-stamped. Joint and Maddie have no legacy records.

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

The new SQLite schema is version 9. Production migrated from schema 7; the pre-migration recovery bundle and disposable restore/migration rehearsal were verified before activation. For any future production migration:

1. Make and verify a complete private recovery bundle using the existing backup procedure.
2. Confirm the exact owner logins and `publicOrigin` in the private runtime configuration; do not put them in source control.
3. On a reviewed copy, verify the intended account and budget attribution and compare Combined totals before and after. Preserve unresolved classifications for records that cannot be confirmed.
4. Review transaction overrides for salary and shared-account activity. Review each property and linked mortgage.
5. If rollback is needed after migration, restore the complete pre-migration recovery bundle with the compatible runtime. Do not point older code at the migrated database or attempt a symlink-only downgrade.

Account ownership changes show a preview of inherited and explicitly overridden transactions and holdings. The server blocks moves that would leave known savings-goal, commitment, or mortgage links under an incompatible profile, pins the preview revision, records an audit history, and offers guarded undo. Compatible linked goals, commitments, scenarios, properties, and mortgages can be reassigned together after explicit confirmation; incompatible dependencies fail closed. Preview and mutation validation use the complete SQLite relationship state. Goal-allocation undo revalidates current ownership and available cash. Provider refresh preserves ownership history and edit versions, so a balance refresh alone does not invalidate a safe ownership undo. Property owner changes are checked against linked liability accounts. Goal cash allocations, commitment matches, scenario links, and reimbursements have cross-profile validation. Manually review investments and all related links before changing owners. Keep an audit copy of pre-change ownership and household totals.

## Verification and rollout limits

`npm run test:ci` passed on source candidate SHA-256 `a3d603a1fd4fa8c837887afdfbce262676e2107fdbe660004c70e39d5d530f34` (115 files): fast, integration, encrypted recovery, broad browser acceptance, all 22 isolated browser cases, and release rehearsal. GitHub Actions passed for deployed commit `5f77f24`. The production recovery bundle was restored and the schema 9 migration rehearsed on a disposable copy. Peter confirmed existing records belong to him; the audit-stamped ownership-review marker is cleared. Mixed brokerage attribution remains incomplete because provider data does not support a trustworthy personal valuation allocation; Combined counts the account once. Migration does not recreate any Maddie/Joint plans or audit history already lost. See [HOUSEHOLD_PROFILES_EXECUTION.md](HOUSEHOLD_PROFILES_EXECUTION.md) and [HOUSEHOLD_PROFILES_PLAN_LUNA_HIGH.md](HOUSEHOLD_PROFILES_PLAN_LUNA_HIGH.md) for evidence and remaining follow-up.

Deployment, migration, and existing ownership confirmation are complete. Remaining access work: configure Maddie's Tailscale identity and test her login. Historical Maddie/Joint plans or audit data that were lost before migration still need reconciliation if authoritative records are available. Bank sync scheduling remains unchanged.
