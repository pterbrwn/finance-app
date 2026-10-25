# Local backup recovery

Ledger's backup service is intended for a private Linux user service using SQLite. Each successful run creates an online SQLite backup, verifies SQLite integrity and foreign keys, publishes the file atomically with mode `600`, then applies retention. The backup directory and status file use mode `700` and `600`.

Retention keeps the seven newest daily snapshots and the newest snapshot from each of the four most recent ISO weeks. A snapshot selected by both rules is stored once. Files named `pre-migration-*.sqlite` are protected from automatic pruning for the migration rollback window. Unrecognized backup filenames are left alone.

The service and timer templates are in `deploy/ledger-backup.service` and `deploy/ledger-backup.timer`. Install and enable them only as part of the accepted SQLite rollout. This timer is separate from the bank synchronization timer.

## Recovery checklist

1. Stop the application writer and any job that can mutate the database. Do not restore over a database that has newer writes.
2. Preserve the current database, its `-wal` and `-shm` files if present, the selected backup, and the private Ledger configuration as a separate recovery set.
3. Keep the configuration that contains the matching token-encryption key with the database. The encrypted provider tokens cannot be recovered from a database without that key. Never copy the key into a release, log, screenshot, or support message.
4. Restore to a new destination with `scripts/sqlite-restore.mjs BACKUP_FILE NEW_DATABASE_PATH`. The restore command verifies integrity and foreign keys and refuses to replace an existing destination. It shares a lock with scheduled backup and pruning.
5. Open the restored database with the matching compatible application, verify owner access and safe aggregate reconciliation, and only then plan any controlled cutover.

Settings reports the last attempt, last verified success, a bounded failure category, and the actual systemd timer state. It never displays filesystem paths or raw errors. Missing SQLite configuration is reported as not configured, not as a successful backup.
