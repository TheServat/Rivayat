/**
 * The migrations, run against a database that already holds the old shape.
 *
 * A migration proved only against an empty database has proved the DDL parses. What it
 * has not proved is the part that can lose data: that the rows already out there arrive
 * on the other side, in the right table, with the right values. Both changes in 0002
 * are of that kind - a table rename carrying live rows, and a column whose vocabulary
 * was lossy - so every test here seeds the *previous* schema first and then migrates.
 *
 * "The previous schema" is not a hand-written fixture; it is migrations 0000 and 0001,
 * copied into a temp folder with a truncated journal and applied by the same migrator
 * the application uses. Anything else would be a test of a guess about what shipped.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { unwrap } from '@rv/shared-kernel';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type DatabaseHandle, createDatabase, migrationsFolder } from '../database/database';

/** How far back "the old shape" is. Everything before 0002. */
const UP_TO = 2;

const NOW = '2026-08-23T00:00:00.000Z';
const ULID_A = '01J9ZQ3K5M7N9P1R3T5V7XA001';
const ULID_B = '01J9ZQ3K5M7N9P1R3T5V7XA002';
const ULID_C = '01J9ZQ3K5M7N9P1R3T5V7XA003';
const ULID_D = '01J9ZQ3K5M7N9P1R3T5V7XA004';

interface Journal {
  readonly version: string;
  readonly dialect: string;
  readonly entries: { readonly idx: number; readonly tag: string }[];
}

let temp: string;

/**
 * A folder holding only the first `count` migrations.
 *
 * The journal is truncated rather than rewritten, so the entries that remain are
 * byte-identical to the committed ones and the migrator computes the same hashes for
 * them. That is what lets the real folder be applied on top afterwards and skip them.
 */
function folderUpTo(count: number): string {
  const source = migrationsFolder();
  const target = join(temp, `up-to-${String(count)}`);
  mkdirSync(join(target, 'meta'), { recursive: true });

  const journal = JSON.parse(
    readFileSync(join(source, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const kept = journal.entries.slice(0, count);
  for (const entry of kept) {
    cpSync(join(source, `${entry.tag}.sql`), join(target, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(target, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: kept }, null, 2),
    'utf8',
  );
  return target;
}

/** A database at the previous schema, with nothing in it yet. */
function openAtOldShape(): DatabaseHandle {
  const handle = unwrap(createDatabase(':memory:', { applyMigrations: false }));
  migrate(handle.db, { migrationsFolder: folderUpTo(UP_TO) });
  return handle;
}

/** Applies everything still outstanding, exactly as the application would. */
function migrateToHead(handle: DatabaseHandle): void {
  migrate(handle.db, { migrationsFolder: migrationsFolder() });
}

function rows(handle: DatabaseHandle, sql: string): Record<string, unknown>[] {
  return handle.sqlite.prepare(sql).all() as Record<string, unknown>[];
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'rv-migrations-'));
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe('0002 renames the belief table without touching the rows', () => {
  function seedBelief(handle: DatabaseHandle): void {
    handle.sqlite
      .prepare(
        `INSERT INTO entities (id, series_id, kind, canonical_name, aliases, summary,
           first_appearance_ordinal, importance, asset_refs, payload)
         VALUES (?, ?, 'character', 'Kael', '[]', 'A ferryman.', 1, 'lead', '[]', '{}')`,
      )
      .run(`ent_${ULID_A}`, `ser_${ULID_A}`);
    handle.sqlite
      .prepare(
        `INSERT INTO relations (id, series_id, from_entity_id, to_entity_id, type, fact,
           strength, asserted_at, source_ref, confidence, visibility)
         VALUES (?, ?, ?, ?, 'knows', 'Kael knows the crossing is cursed.', 0.75, ?, '{}', 1, 'public')`,
      )
      .run(`rel_${ULID_A}`, `ser_${ULID_A}`, `ent_${ULID_A}`, `ent_${ULID_A}`, NOW);
    handle.sqlite
      .prepare(
        `INSERT INTO facts (id, series_id, holder_id, relation_id, fact, via,
           learned_at_ordinal, confidence)
         VALUES (?, ?, ?, ?, 'I think the crossing is cursed.', 'believes-falsely', 30, 0.4)`,
      )
      .run(`fct_${ULID_B}`, `ser_${ULID_A}`, `ent_${ULID_A}`, `rel_${ULID_A}`);
  }

  it('carries an existing belief into `beliefs` with its values intact', () => {
    const handle = openAtOldShape();
    seedBelief(handle);

    migrateToHead(handle);

    const [belief] = rows(handle, 'SELECT * FROM beliefs');
    expect(belief?.proposition).toBe('I think the crossing is cursed.');
    expect(belief?.via).toBe('believes-falsely');
    expect(belief?.confidence).toBe(0.4);
    expect(belief?.learned_at_ordinal).toBe(30);
    handle.close();
  });

  it('moves the belief out of the fact id space, keeping its ULID', () => {
    const handle = openAtOldShape();
    seedBelief(handle);

    migrateToHead(handle);

    // Prefix swap, not a re-mint: the body is the same, so the row is still
    // recognisable next to whatever referenced it before the rename.
    expect(rows(handle, 'SELECT id FROM beliefs')[0]?.id).toBe(`bel_${ULID_B}`);
    handle.close();
  });

  it('leaves `facts` empty and shaped for a `Fact`, not for a belief', () => {
    const handle = openAtOldShape();
    seedBelief(handle);

    migrateToHead(handle);

    // The old row went to `beliefs`; nothing was copied into the new table, because a
    // belief is not a fact and inventing facts out of beliefs is the exact confusion
    // the rename exists to end.
    expect(rows(handle, 'SELECT * FROM facts')).toEqual([]);
    const columns = rows(handle, 'PRAGMA table_info(facts)').map((column) => column.name);
    expect(columns).toContain('content_kind');
    expect(columns).toContain('covers');
    expect(columns).not.toContain('holder_id');
    handle.close();
  });

  it('keeps the belief foreign keys enforced after the rename', () => {
    const handle = openAtOldShape();
    seedBelief(handle);
    migrateToHead(handle);

    // `ALTER TABLE ... RENAME TO` preserves the constraints; a rebuild would have been
    // free to drop them silently, and this is the assertion that tells the two apart.
    expect(() =>
      handle.sqlite
        .prepare(
          `INSERT INTO beliefs (id, series_id, holder_id, relation_id, proposition, via, confidence)
           VALUES (?, ?, ?, ?, 'x', 'knows', 1)`,
        )
        .run(`bel_${ULID_C}`, `ser_${ULID_A}`, `ent_${ULID_D}`, `rel_${ULID_A}`),
    ).toThrow();
    handle.close();
  });

  it('frees the index names the new fact table needs', () => {
    const handle = openAtOldShape();
    seedBelief(handle);
    migrateToHead(handle);

    // `facts_relation_idx` existed on the old table and survives a rename pointing at
    // `beliefs`; the new table needs the name back. If the drop were missed the
    // migration would fail here rather than at some later CREATE.
    const indexes = rows(
      handle,
      "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE '%relation_idx'",
    );
    expect(indexes).toEqual([
      { name: 'beliefs_relation_idx', tbl_name: 'beliefs' },
      { name: 'facts_relation_idx', tbl_name: 'facts' },
    ]);
    handle.close();
  });
});

describe('0002 recovers the run state the five-value column could not hold', () => {
  function seedRun(
    handle: DatabaseHandle,
    id: string,
    state: string,
    metadata: Record<string, unknown>,
  ): void {
    handle.sqlite
      .prepare(
        `INSERT INTO runs (id, project_id, stage, state, spent_nano_usd, seed, metadata, started_at)
         VALUES (?, ?, 'produce', ?, 0, 7, ?, ?)`,
      )
      .run(id, `prj_${ULID_A}`, state, JSON.stringify(metadata), NOW);
  }

  it('tells a cancelled run from a crashed one, which the column could not', () => {
    const handle = openAtOldShape();
    // Both were stored as `failed`. The repository wrote the true status into
    // `metadata.status` for exactly this moment.
    seedRun(handle, `run_${ULID_A}`, 'failed', { status: 'cancelled' });
    seedRun(handle, `run_${ULID_B}`, 'failed', { status: 'failed' });

    migrateToHead(handle);

    const states = new Map(
      rows(handle, 'SELECT id, state FROM runs').map((row) => [row.id, row.state]),
    );
    expect(states.get(`run_${ULID_A}`)).toBe('cancelled');
    expect(states.get(`run_${ULID_B}`)).toBe('failed');
    handle.close();
  });

  it('maps the old `done` onto the pipeline vocabulary', () => {
    const handle = openAtOldShape();
    seedRun(handle, `run_${ULID_A}`, 'done', { status: 'succeeded' });
    // A seeder or a test wrote this one: `done` with no metadata to recover from.
    seedRun(handle, `run_${ULID_B}`, 'done', { episode: 'E01' });

    migrateToHead(handle);

    expect(rows(handle, "SELECT id FROM runs WHERE state = 'succeeded'").map((r) => r.id)).toEqual([
      `run_${ULID_A}`,
      `run_${ULID_B}`,
    ]);
    expect(rows(handle, "SELECT id FROM runs WHERE state = 'done'")).toEqual([]);
    handle.close();
  });

  it('leaves an unrecoverable failure alone rather than guessing', () => {
    const handle = openAtOldShape();
    // No `metadata.status`: nothing in the database says whether this was stopped or
    // broke. `failed` is the honest answer and a guess would be worse than the gap.
    seedRun(handle, `run_${ULID_A}`, 'failed', { episode: 'E01' });

    migrateToHead(handle);

    expect(rows(handle, 'SELECT state FROM runs')[0]?.state).toBe('failed');
    handle.close();
  });

  it('survives metadata that is not JSON at all', () => {
    const handle = openAtOldShape();
    handle.sqlite
      .prepare(
        `INSERT INTO runs (id, project_id, stage, state, spent_nano_usd, seed, metadata, started_at)
         VALUES (?, ?, 'produce', 'done', 0, 7, 'not json', ?)`,
      )
      .run(`run_${ULID_A}`, `prj_${ULID_A}`, NOW);

    // `json_extract` on a non-JSON text raises, which would abort the whole migration
    // and leave the workspace unopenable. The `json_valid` guard is what stops it.
    expect(() => {
      migrateToHead(handle);
    }).not.toThrow();
    expect(rows(handle, 'SELECT state FROM runs')[0]?.state).toBe('succeeded');
    handle.close();
  });

  it('leaves a run that was already in a good state untouched', () => {
    const handle = openAtOldShape();
    seedRun(handle, `run_${ULID_A}`, 'running', { status: 'running' });
    seedRun(handle, `run_${ULID_B}`, 'paused', {});

    migrateToHead(handle);

    const states = rows(handle, 'SELECT id, state FROM runs ORDER BY id').map((row) => row.state);
    expect(states).toEqual(['running', 'paused']);
    handle.close();
  });
});

describe('0002 is safe to re-run and safe on an empty database', () => {
  it('applies to an empty workspace and leaves the head schema', () => {
    const handle = unwrap(createDatabase(':memory:'));
    const tables = rows(
      handle,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).map((row) => row.name);

    expect(tables).toContain('beliefs');
    expect(tables).toContain('facts');
    expect(tables).toContain('projects');
    expect(tables).toContain('series');
    expect(tables).toContain('render_artifacts');
    expect(tables).toContain('produce_checkpoints');
    handle.close();
  });

  it('does not apply twice when the migrator runs again', () => {
    const handle = openAtOldShape();
    migrateToHead(handle);

    // The second call must be a no-op. If 0002 ran twice the rename would fail, which
    // is the failure mode that makes an API restart unrecoverable.
    expect(() => {
      migrateToHead(handle);
    }).not.toThrow();
    handle.close();
  });
});
