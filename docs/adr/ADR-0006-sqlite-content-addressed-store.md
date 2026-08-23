# ADR-0006: SQLite + Drizzle for metadata, a content-addressed filesystem for binaries

**Status:** Accepted — 2026-08-23. Shares its substrate with ADR-0004; its economics depend on
ADR-0002.

## Context

Two kinds of state, with opposite characteristics, and conflating them is the usual mistake.

**Metadata** — projects, series, episodes, style bibles, asset records, versions, variants, rig
definitions, the narrative graph, the cost ledger, pipeline checkpoints. Small rows, heavily
queried, relational, transactional, and the thing every use-case reads.

**Binaries** — generated PNGs, RGBA part layers, sprite atlases, PNG frame sequences, rendered
masters. Large, immutable once written, and referenced by many rows across many projects.

The requirements that decided it:

- **Local-first, zero-ops.** Clone, `pnpm install`, run. A user must not install or administer a
  database server before writing episode 1.
- **Non-negotiable #2 — no asset is generated twice.** Deduplication has to be a property of the
  store, not a discipline. Two projects that need the same oak tree in the same style must share
  one file.
- **Reproducibility and audit.** Every artefact records `{ prompt, model, seed, params,
parentIds, cost, ts }`, and the cost ledger is queried before spending (non-negotiable #3).
- **A credible growth path.** Multi-user or hosted deployment must not require rewriting the
  application layer.

## Decision

### Metadata: SQLite (`better-sqlite3`) + Drizzle ORM 0.45

A single file at `RV_DB_URL=file:./workspace/rivayat.db`. Synchronous, in-process, no server, no
connection pool, no port. Drizzle for typed schema and migrations, chosen because its query
builder is thin, its types are inferred from the schema, and its SQL dialect abstraction is what
makes the Postgres swap below plausible rather than aspirational.

**All access goes through `interface XRepository` declared in the application layer.** No engine,
use-case or domain object imports Drizzle, `better-sqlite3` or SQL. This is enforced by
`.dependency-cruiser.cjs` in CI, not by convention.

### Binaries: a content-addressed store on the filesystem

```
workspace/assets/<sha[0:2]>/<sha256>/…
```

The path _is_ the identity. Writing is `hash → if exists, done → else write`, which makes
deduplication automatic and idempotent, makes writes safe to retry, and makes any file
independently verifiable. Files are immutable; a new take is a new hash and a new `AssetVersion`,
never an overwrite. The store is **shared across all projects** — a project references assets, it
never owns them — which is the mechanism behind "episode N+1 is nearly free" (ADR-0002).

The two-character shard prefix exists so no directory holds hundreds of thousands of entries, which
is where NTFS and ext4 both start to hurt.

### The seam between them

The database stores the hash and the metadata; the filesystem stores the bytes. Deleting a row
never deletes a file — reclamation is a separate, explicit mark-and-sweep against all referencing
rows, because a hash may be referenced by a project we are not looking at.

### The Postgres swap

The application layer depends only on repository interfaces:

```ts
interface AssetRepository {
  findByDedupKey(key: DedupKey): Promise<Result<Asset | null>>;
  save(asset: Asset): Promise<Result<Unit>>;
  // …
}
```

Swapping means: a `drizzle-orm/pg-core` schema alongside the `sqlite-core` one, a
`PgAssetRepository` implementing the same interface, and a DI binding chosen from `RV_DB_URL`'s
scheme (`file:` → SQLite, `postgres:` → Postgres). **No use-case, entity or engine changes.** The
same swap applies to the binary store: `ContentStore` is a port, and an S3/MinIO adapter is a new
implementation of it, not a new call site — the content hash is already the object key.

`docker-compose.yml` ships a commented-out Postgres service so the swap is a documented path
rather than a claim. The repository contract test suite runs against both implementations, which
is what actually keeps the swap honest.

## Consequences

**Positive.** Nothing to install, nothing to run, nothing to administer; a series is one directory
and backing it up is `cp -r`. Deduplication is structural rather than a check somebody might
forget. Transactions are real and free — an episode transition writes graph edges, entity rows and
checkpoints atomically. Tests use an in-memory SQLite (`:memory:`) and a temp-dir content store, so
the integration suite needs no services and runs in CI. The narrative graph (ADR-0004) shares the
same file, so graph writes and metadata writes are one transaction.

**Negative.** SQLite has **one writer at a time**. With WAL mode readers do not block, but
concurrent BullMQ workers writing metadata will serialise, and long write transactions will make
that visible. Mitigation: keep write transactions short, and never hold one across a provider call
— a rule the use-case layer has to actually follow. `better-sqlite3` is a native module, so the
install needs a prebuilt binary (it is listed in `onlyBuiltDependencies`) and CI must not skip
build scripts. There is no built-in vector index: semantic retrieval is embeddings stored as
blobs with similarity computed in process, which is fine for a series-sized graph and would not be
fine at a much larger scale. The CAS grows monotonically until the sweep runs, and the sweep is
work we own.

**Explicitly accepted:** this design is single-machine. Multi-user, concurrent-writer, or hosted
operation is a Postgres + object-store deployment, and the repository seam is the entire reason
that is a configuration change instead of a rewrite.

## Alternatives considered

**Postgres from day one.** The endpoint, so it was the obvious start. Rejected on **zero-ops**:
it requires a server (or Docker) running before the app does anything, which is a worse first-run
experience for a local creative tool, and it buys nothing at single-user scale — no
multi-writer contention exists to solve. Kept as the documented swap instead of the default.

**Store binaries as SQLite BLOBs.** Rejected: it puts hundreds of megabytes of PNGs and frame
sequences in the same file as the metadata, which makes backups enormous, makes the file
lock-sensitive during renders, and prevents FFmpeg, `sharp` and Playwright from reading assets as
plain files — they would need extraction to temp on every access. Content addressing on the
filesystem also gives dedup and verification for free, which a BLOB column does not.

**A document store (LevelDB / LMDB / a JSON tree on disk).** Rejected: the domain is relational —
episodes belong to seasons, relations join entities, the cost ledger aggregates by provider and
day. Losing joins and ad-hoc queries means rebuilding them in application code, badly. The
narrative graph in particular needs recursive queries.

**A dedicated object store (S3 / MinIO) for binaries from the start.** Rejected as the default for
the same zero-ops reason, and because local-first means the assets should be sitting in a
directory the user can open. `ContentStore` is a port precisely so this becomes an adapter when
someone deploys, and the content hash is already the natural object key.

**Filesystem-only, no database (JSON sidecar files).** Rejected: it is where this kind of tool
usually starts and where it always breaks. No transactions, no indexes, no aggregate queries, and
the cost ledger and dedup index degrade into full directory scans. The dedup key lookup
(non-negotiable #2) must be an indexed query on the hot path of every generation request.

**Random UUID filenames instead of content addressing.** Rejected: identical bytes would be stored
under different names, which silently defeats cross-project deduplication — the single mechanism
that makes episode N+1 nearly free — and removes the ability to verify a file against its name.
