# Database (SQLite)

VirtPilot uses an embedded SQLite database for state that needs to survive
restarts but doesn't fit the "live from libvirt" model. Most VM state is still
queried directly via `virsh`; the database is reserved for things libvirt
itself doesn't track — historical metrics being the first such case.

## File location

```
$STORAGE_ROOT/virtpilot.db        # default: /var/lib/virtpilot/virtpilot.db
$STORAGE_ROOT/virtpilot.db-wal    # write-ahead log (transient)
$STORAGE_ROOT/virtpilot.db-shm    # shared-memory index (transient)
```

The DB file is created on first boot if missing. It lives under the same
storage root as templates/ISOs/VMs, so a single `STORAGE_ROOT` env var moves
everything together.

## Driver

[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — synchronous,
in-process, no daemon. Chosen because:

- Synchronous fits Node's single-threaded event loop without async overhead;
  prepared statements are essentially zero-cost.
- Ships prebuilt binaries for Linux/macOS on Node 20, so `npm install` doesn't
  need to compile native code on the host. (Build tools — `build-essential`,
  `python3` — are present in `install.sh` as a fallback.)
- WAL mode tolerates the read-during-write pattern the metrics endpoint uses.

## Pragmas

Set on every connection (see [packages/backend/src/services/db.ts](packages/backend/src/services/db.ts)):

| Pragma                | Value      | Why                                           |
| --------------------- | ---------- | --------------------------------------------- |
| `journal_mode`        | `WAL`      | concurrent reads while sampler writes         |
| `synchronous`         | `NORMAL`   | safe with WAL; faster than `FULL`             |
| `foreign_keys`        | `ON`       | enforce relational constraints if added later |

## Migrations

Schema versioning uses SQLite's `user_version` PRAGMA. Each migration is an
entry in the `migrations` array in [db.ts](packages/backend/src/services/db.ts):

```ts
{
  version: 1,
  up: (db) => {
    db.exec(`CREATE TABLE ...`);
  },
}
```

On boot, `runMigrations` runs every entry whose `version > user_version` inside
a transaction, then bumps `user_version`. Migrations are append-only — never
edit a previous entry; add a new one.

## Current schema

### `vm_metrics`

Per-VM time-series samples written by the metrics sampler at 30-second cadence.

| Column           | Type    | Notes                                  |
| ---------------- | ------- | -------------------------------------- |
| `vm_name`        | TEXT    | libvirt domain name                    |
| `ts`             | INTEGER | unix ms                                |
| `cpu_percent`    | REAL    | 0–100, normalised across vCPUs         |
| `mem_used_mb`    | INTEGER | guest-reported via balloon if present  |
| `mem_total_mb`   | INTEGER |                                        |
| `disk_read_bps`  | REAL    | bytes/sec, summed across block devices |
| `disk_write_bps` | REAL    |                                        |
| `net_rx_bps`     | REAL    | bytes/sec, summed across interfaces    |
| `net_tx_bps`     | REAL    |                                        |

- Primary key: `(vm_name, ts)`
- Index: `idx_vm_metrics_ts` on `ts` (for the prune sweep)
- Retention: 24 hours, pruned every ~30 minutes (60 sampler ticks)
- Range queries downsample on read: `1h` returns raw 30s samples
  (~120 points); `24h` aggregates into 5-minute buckets via SQL `AVG`
  (~288 points).

## Lifecycle hooks

The metrics service exposes two hooks the rest of the codebase calls:

- `deleteVmMetrics(vmName)` — wired into `DELETE /api/vms/:name` so a deleted
  VM's history is purged.
- `renameVmMetrics(oldName, newName)` — wired into `PUT /api/vms/:name/rename`
  so history follows the rename. The internal counter cache (used to compute
  per-tick deltas) is also re-keyed.

## Adding a new table

1. Open [db.ts](packages/backend/src/services/db.ts).
2. Append a new migration to the `migrations` array with the next version
   number. Use `db.exec` for the DDL.
3. Create a service module under
   [packages/backend/src/services/](packages/backend/src/services/) that calls
   `getDb()` and uses prepared statements. Cache the prepared statement at
   module level — `db.prepare` is cheap but not free.
4. If the data is per-VM, wire `delete*` and `rename*` helpers into
   [packages/backend/src/routes/vms.ts](packages/backend/src/routes/vms.ts) so
   the table stays consistent with the libvirt domain list.

## Backups

The DB file is part of `STORAGE_ROOT` and will be included in any
filesystem-level backup of that directory. There's no separate dump command —
SQLite's WAL means a hot copy may need `.backup` semantics; for a clean copy,
stop the service first.

## Operating notes

- The DB connection is a singleton (`getDb()`); do not open additional
  handles — they would compete for the WAL.
- Sampling and pruning never throw out of `vmMetricsService`; DB errors are
  swallowed so a transient I/O issue can't crash the sampler loop.
- The DB file is owned by the user that runs the systemd service (typically
  root, since libvirt access requires it).
