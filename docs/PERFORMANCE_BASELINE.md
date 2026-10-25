# Synthetic performance baseline

Captured 2026-10-25 UTC with the pinned Node.js 24.22.1 runtime on Linux ARM64, Cortex-A78AE, six CPUs, and 8 GB RAM. Run with `npm run measure:performance -- 10000 100000`. The script creates and removes private temporary SQLite datasets and prints JSON; it does not read real records or change the application checkout's generated `dist`.

Each dataset has eight manual accounts, evenly distributed transactions from 2016–2026, 500 repeated merchant names, five categories, refunds, pending/review rows, category overrides, and synthetic goals/allocation, property/mortgage, scenario, balance snapshot, and budget records. The 5,000-row CSV fixture is 243,271 bytes. Reads use three samples; the first state response and mutation/import/recovery operations use one sample. P95 for three read samples is a descriptive observation, not a stable statistical guarantee. The “cold” state sample is the first request after opening the repository; the OS page cache has already seen the synthetic database during fixture creation.

| Operation | 10k: median / p95 | 100k: median / p95 | Response / artifact |
|---|---:|---:|---:|
| First `/api/state` response | 152.56 / 152.56 ms | 720.46 / 720.46 ms | 2,132,795 / 21,237,585 bytes |
| Warm `/api/state` response | 66.59 / 77.07 ms | 605.67 / 615.53 ms | 2,132,795 / 21,237,585 bytes |
| Filtered search, 50-row page | 31.06 / 31.73 ms | 274.57 / 317.84 ms | 10,625 / 10,735 bytes |
| Selected-month local aggregation | 1.48 / 2.29 ms | 11.35 / 14.51 ms | In-process; the full state had already been loaded |
| One category mutation | 242.59 ms | 2,255.29 ms | Includes state read and whole-state mutation path |
| 100-row category bulk edit | 210.97 ms | 2,365.96 ms | Includes state read and whole-state mutation path |
| One sync-page commit | 133.73 ms | 1,466.25 ms | Synthetic repository commit |
| 5,000-row import preview | 161.24 ms | 559.12 ms | CSV fixture: 243,271 bytes |
| 5,000-row import commit | 337.92 ms | 2,121.80 ms | 5,000 inserted |
| Restart and reopen SQLite | 14.33 ms | 7.24 ms | One sample |
| Duplicate detection after restart | 149.82 ms | 549.33 ms | Correctly recognized existing import |
| Undo the 5,000-row import | 193.91 ms | 1,802.92 ms | 5,000 removed |
| Verified backup / restore | 160.28 / 262.66 ms | 496.49 / 805.16 ms | 7,467,008 / 35,696,640 byte backup |

| Process observation | 10k | 100k |
|---|---:|---:|
| Heap after workload | 60,247,376 bytes | 722,286,384 bytes |
| Peak sampled heap | 72,399,144 bytes | 722,279,952 bytes |
| Peak sampled RSS | 279,404,544 bytes | 1,033,641,984 bytes |
| Event-loop delay p95 during workload | 462.95 ms | 2,589.98 ms |

## C08 bottlenecks

- Routine bootstrap transfers every transaction and supporting record. The response is over 2 MB at 10k and over 21 MB at 100k, so it fails the plan's structural requirement to avoid transferring history on routine refresh.
- The filtered page is within the planned response-size and warm-latency targets, but it scans and sorts the full in-memory transaction array. At 100k it reaches 317.84 ms p95 and grows with history; replace this with indexed SQLite page queries and a stable date/ID cursor or offset contract.
- Category, bulk, sync-page, import commit, and import undo operations rewrite/load the complete state. At 100k, the measured write paths take about 1.5–2.4 seconds and cause event-loop delay up to 2.59 seconds p95. Replace the affected write paths with scoped transactional SQLite operations while preserving revision checks, undo, and transaction/cursor atomicity.
- Month aggregation is cheap once all state is already in memory, but there is no bounded server summary path in this measurement. C08 must add a summary query over all matching rows so overview totals remain complete after bootstrap becomes bounded.
- The 100k workload reached about 1.03 GB peak RSS and 722 MB heap. C08 must avoid building repeated full-state copies for reads and writes.

The filtered-page planning targets were met at both sizes: response below 256 KiB and warm p95 below one second at 10k / two seconds at 100k. This does not satisfy the separate full-state transfer, query-scaling, write-path, or browser-render requirements. Browser input/render delay remains unmeasured pending C10.

## C08 read-path interim measurement

After the first C08 read-path implementation, rerun on the same host and fixture (2026-10-25 UTC). `/api/state` dropped to 11,310 bytes at 10k and 11,311 bytes at 100k. Warm bootstrap p95 was 14.12 ms / 181.98 ms; filtered search page p95 was 26.29 ms / 201.31 ms with 10,625 / 10,735 byte responses. The page is now queried from SQLite using date/account/item indexes and bounded row materialization. Monthly summaries query matching month rows and return aggregates, weekly buckets, recent six records, and total count. The UI requests complete history only through explicit paginated export.

At 100k, sampled peak RSS fell to 753 MB and heap to 390 MB. The read change leaves full-state mutations in place: one category edit and a 100-row bulk edit were about 3.07–3.11 seconds, a sync-page commit 2.60 seconds, 5k import commit 3.41 seconds, and undo 3.18 seconds. These single-sample values are noisy, but confirm that C08's separate scoped-write slice is still required. The JSON repository preserves the same bounded API contract but currently filters its full in-memory state as a transitional path.

## C08 read and scoped-write comparison

Captured 2026-10-25 UTC on the same host and fixture after bounded reads and scoped SQLite writes. Category, bulk-category, CSV commit/undo, and sync-page values include the current worker's state read, API validation, selected-row lookup, and transactional commit. Each write measurement is a single sample. Sync uses a representative one-row page and commits the row with its item cursor. This is synthetic evidence, not a production workload guarantee.

| Operation | 10k: median / p95 | 100k: median / p95 | C07 100k comparison |
|---|---:|---:|---:|
| First `/api/state` response | 93.42 / 93.42 ms | 174.78 / 174.78 ms | 21,237,585 bytes before; now 11,358 bytes |
| Warm `/api/state` response | 12.20 / 15.27 ms | 164.58 / 171.16 ms | 605.67 / 615.53 ms |
| Filtered search, 50-row page | 26.32 / 26.85 ms | 196.75 / 196.80 ms | 274.57 / 317.84 ms |
| One category mutation | 44.09 ms | 420.83 ms | 2,255.29 ms |
| 100-row category bulk edit | 47.22 ms | 417.86 ms | 2,365.96 ms |
| One sync-page commit with cursor | 3.13 ms | 2.54 ms | 1,466.25 ms |
| 5,000-row import preview | 151.02 ms | 509.16 ms | 559.12 ms |
| 5,000-row import commit | 333.75 ms | 745.75 ms | 2,121.80 ms |
| Duplicate detection after restart | 162.50 ms | 564.39 ms | 549.33 ms |
| Undo the 5,000-row import | 182.40 ms | 398.12 ms | 1,802.92 ms |
| Filtered page response bytes | 10,625 | 10,735 | 10,625 / 10,735 |
| Peak sampled RSS | 196,730,880 bytes | 425,709,568 bytes | 1,033,641,984 bytes |

Scoped SQLite transactions now update only the selected transaction IDs for category edits, import commit/undo, and provider transaction pages. The sync path commits the changed rows, cursor, account/item state, job progress, and revision together after provider requests finish. The JSON repository retains its prior optimistic whole-state behavior. At 100k, category and import writes improved materially; the sync-page write fell from about 1.47 seconds to 2.54 ms. Import preview and duplicate detection still inspect transaction history and remain linear in record count. The API's mutation entry path also loads current state for domain validation, so category request latency still grows with total history even though persistence no longer rewrites it.

The source suite and local HTTP checks passed on disposable copies after this slice. The root checkout `dist`, live service, timers, and private records were not changed. Browser rendering and assistive-technology performance remain unmeasured under C10.
