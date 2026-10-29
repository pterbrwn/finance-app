# Local recovery bundles

A successful scheduled backup now records whether it created a complete recovery bundle. A complete bundle contains:

- A verified SQLite database snapshot.
- A mode-0600 copy of the exact local configuration observed while that snapshot was made.
- A mode-0600 manifest with database and configuration checksums, schema version, build identity, and a non-reversible encryption-key fingerprint.

The bundle directory is mode 0700. Its configuration copy can contain provider credentials and the token-encryption key. Keep it private. Encrypt any offline copy and store it separately from the device.

## Rehearse a restore

Use a new, empty destination. The restore command verifies the bundle, checks SQLite integrity and foreign keys, and refuses to overwrite an existing destination:

```sh
node scripts/sqlite-restore.mjs /path/to/daily-TIMESTAMP.recovery /new/empty/location/ledger.sqlite
```

The command restores only the database. The matching `config.json` remains inside the recovery bundle; an operator must place it in the intended private configuration location with mode 0600 before using that database. Review the manifest's build and schema identities first. Do not replace a working database or configuration as part of a rehearsal.

A legacy `.sqlite` backup can still be restored directly, but it is database-only. It does not prove that encrypted provider tokens can be decrypted. The Settings page reports bundle checksum validation, SQLite integrity, local decryption of stored token blobs (or that there are no stored tokens), recovery age, and whether an encrypted restore rehearsal has passed. A key fingerprint alone is not token-decryption evidence; restore rehearsal remains separate.

Synthetic recovery checks validate paired-key decryption, exact record IDs and totals, file permissions, and rejection of a wrong key, missing configuration, or corrupted copy. They do not perform an owner-data recovery or change a running service.

## Optional encrypted off-device export

`age` is an optional operator-installed executable; Ledger does not install it, enable a timer, or configure an external destination. After selecting an acceptable destination and protecting an `age` identity separately, create a current verified bundle and run from the trusted Jetson shell:

```sh
LEDGER_RECOVERY_BUNDLE=/private/path/to/current.recovery \
LEDGER_ENCRYPTED_BACKUP_DIR=/mounted/owner-selected/destination \
LEDGER_AGE_RECIPIENT=age1... \
bash scripts/run-node.sh scripts/encrypted-backup.mjs
```

The destination directory is configured in the operator environment, never in the browser. The command validates checksums, SQLite integrity, and stored-token decryption before streaming a tar archive through `age`. It creates mode-0600 ciphertext atomically and refuses overwrite. Keep the decryption identity outside this backup and test on a separate device. A second folder on the Jetson is not device-loss protection.

For a synthetic or planned restore rehearsal, set `LEDGER_ENCRYPTED_RECOVERY_FILE`, `LEDGER_AGE_IDENTITY`, and a new `LEDGER_RESTORE_REHEARSAL_DIR`, then run `scripts/encrypted-backup.mjs restore-rehearsal`. It decrypts into a fresh directory and verifies the bundle without activating it. Record owner-selected destination, acceptable data-loss window, and restore-time target before treating this as disaster recovery readiness.

## Portable financial export

A complete, versioned JSON snapshot can be written by the operator CLI to a new private file:

```sh
LEDGER_PORTABLE_EXPORT_FILE=/private/path/to/ledger-finances.json \
bash scripts/run-node.sh scripts/portable-export.mjs
```

The export uses one SQLite read transaction, enforces record and byte bounds, preserves stable IDs and cents, and excludes provider tokens, cursors, credentials, and replay payloads. It does not import or restore data. Protect the resulting file as sensitive financial data.
