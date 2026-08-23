/**
 * The one place `better-sqlite3` is constructed.
 *
 * It takes a URL rather than a path because the URL's scheme is the DI switch ADR-0006
 * describes: `file:` and `:memory:` build the SQLite handle below, and `postgres:` is
 * refused *here*, by name, with a pointer at what implementing it means. A scheme this
 * factory does not know is a configuration error the operator should see at startup,
 * not a silent fallback to a local file nobody meant to create.
 *
 * `:memory:` is a first-class supported URL, not a test affordance bolted on: every
 * repository test in this package runs against a real SQLite with the real migrations
 * applied, because a mocked database cannot fail a unique index and the unique index
 * is where non-negotiable #2 is actually enforced.
 *
 * The pragmas are not decoration. `foreign_keys` is **off** by default in SQLite, so
 * without it every `references()` in the schema is documentation. WAL is what keeps
 * readers from blocking on the single writer ADR-0006 accepts, and `busy_timeout`
 * turns the loser of a write race into a wait instead of an immediate `SQLITE_BUSY`.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type Result,
  UnsupportedCapabilityError,
  ValidationError,
  err,
  ok,
  toAppError,
} from '@rv/shared-kernel';
import BetterSqlite3 from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from '../schema/index';

export type RivayatDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  /** The typed query builder. Everything in `repositories/` goes through this. */
  readonly db: RivayatDatabase;
  /** The raw driver, for pragmas and for the transaction primitives Drizzle wraps. */
  readonly sqlite: BetterSqlite3.Database;
  /** Resolved on-disk location, or `:memory:`. */
  readonly location: string;
  close(): void;
}

export interface CreateDatabaseOptions {
  /** Apply the committed migrations on open. Default `true`. */
  readonly applyMigrations?: boolean;
  /** Override the migrations directory. Defaults to this package's own. */
  readonly migrationsFolder?: string;
  /** Milliseconds a blocked writer waits before giving up. Default 5000. */
  readonly busyTimeoutMs?: number;
}

const IN_MEMORY = ':memory:';

/**
 * Opens the metadata store.
 *
 * Returns a `Result` rather than throwing because an unreachable or unwritable
 * database is an operational failure the caller has to report, not a programmer error.
 */
export function createDatabase(
  url: string,
  options: CreateDatabaseOptions = {},
): Result<DatabaseHandle> {
  const location = resolveLocation(url);
  if (!location.ok) return location;

  try {
    if (location.value !== IN_MEMORY) {
      mkdirSync(dirname(location.value), { recursive: true });
    }

    const sqlite = new BetterSqlite3(location.value);
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma(`busy_timeout = ${String(options.busyTimeoutMs ?? 5000)}`);
    if (location.value !== IN_MEMORY) sqlite.pragma('journal_mode = WAL');

    const db = drizzle(sqlite, { schema });

    if (options.applyMigrations !== false) {
      migrate(db, { migrationsFolder: options.migrationsFolder ?? migrationsFolder() });
    }

    return ok({
      db,
      sqlite,
      location: location.value,
      close: () => {
        sqlite.close();
      },
    });
  } catch (caught) {
    return err(toAppError(caught, `Could not open the database at ${location.value}`));
  }
}

/**
 * URL → filesystem location.
 *
 * `file:./workspace/rivayat.db` is the documented form; a bare path is accepted because
 * that is what a shell tab-completes into an env var.
 */
function resolveLocation(url: string): Result<string> {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return err(new ValidationError({ message: 'Database URL is empty.' }));
  }
  if (trimmed === IN_MEMORY || trimmed === 'file::memory:') return ok(IN_MEMORY);

  if (trimmed.startsWith('postgres:') || trimmed.startsWith('postgresql:')) {
    return err(
      new UnsupportedCapabilityError(
        'persistence/sqlite',
        'postgres - the swap needs a drizzle-orm/pg-core schema and Pg repositories bound to this scheme (ADR-0006)',
      ),
    );
  }

  if (trimmed.startsWith('file://')) return ok(resolve(fileURLToPath(trimmed)));
  if (trimmed.startsWith('file:')) return ok(resolve(trimmed.slice('file:'.length)));

  // Two characters minimum: on Windows a bare path starts `C:\`, and a single-letter
  // "scheme" is a drive letter, not a protocol.
  const scheme = /^([a-z][a-z0-9+.-]+):/i.exec(trimmed);
  if (scheme !== null) {
    return err(
      new ValidationError({
        message: `Unsupported database URL scheme "${scheme[1] ?? ''}". Use "file:", ":memory:", or a bare path.`,
        context: { url: trimmed },
      }),
    );
  }

  return ok(resolve(trimmed));
}

/**
 * Where the committed migrations live, from wherever this module was loaded.
 *
 * Checked in order rather than computed once because the same file is loaded from
 * `src/` under Vitest and from `dist/` after a build, and a migrator pointed at a
 * directory that does not exist fails with a message about SQL, not about paths.
 */
export function migrationsFolder(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(here, '..', 'migrations'),
    join(here, '..', 'src', 'migrations'),
    join(here, '..', '..', 'src', 'migrations'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'meta', '_journal.json'))) ?? '';
}
