/**
 * What the demo seed has to be true about.
 *
 * Three properties, and each is a thing that would otherwise be discovered in production:
 *
 * 1. **It produces the real documents.** Every record is read back out of the database and
 *    re-`parse`d by its own schema, so a field the seed builds by hand but the contract
 *    does not accept fails here rather than at the first request that reads it. The style
 *    bible's `isChecksumValid` is asserted rather than assumed, because a stubbed checksum
 *    is exactly the shortcut this file exists to forbid.
 * 2. **It is re-runnable.** The second call reports `alreadySeeded` and changes no row - and
 *    the clock is advanced between the two calls, so the property cannot be an accident of
 *    both runs stamping the same timestamp.
 * 3. **A missing render is reported, not thrown.** The demo mp4s live under the workspace
 *    root, and a workspace without them is an ordinary operational state (a fresh clone, a
 *    temp dir under test). It has to come back as a `Result`, with the artefact list absent
 *    rather than silently empty.
 *
 * The database is real `:memory:` SQLite with the real migrations, for the reason the
 * harness gives: a mocked store cannot fail a primary key, and the primary key is where
 * idempotency is actually enforced.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Entity, Relation, RenderArtifact, RenderJob, StyleBible } from '@rv/contracts';
import { isChecksumValid, isLocked } from '@rv/core-domain';
import {
  createDatabase,
  entities,
  jobs,
  relations,
  runs,
  styleBibles,
  type DatabaseHandle,
} from '@rv/persistence';
import { FixedClock, NoopLogger, instant, isErr, isOk, sha256 } from '@rv/shared-kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  InMemoryProjectRepository,
  InMemorySeriesRepository,
} from '../persistence/in-memory.repositories';
import { DrizzleRunRepository } from '../persistence/drizzle-run.repository';
import { DEMO_FARHAD_ID, DEMO_GOLAB_ID, DEMO_GOLNAR_ID } from './demo-characters';
import {
  DEMO_PROJECT_ID,
  DEMO_SERIES_ID,
  DEMO_STYLE_BIBLE_ID,
  seedDemo,
  type DemoSeedDeps,
} from './demo-seed';

/** `<repo>/apps/api/src/infrastructure/seed` -> `<repo>/workspace`. */
const WORKSPACE_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'workspace');

interface Fixture {
  readonly deps: DemoSeedDeps;
  readonly database: DatabaseHandle;
  readonly clock: FixedClock;
}

function build(workspaceDir: string): Fixture {
  const opened = createDatabase(':memory:');
  if (isErr(opened)) throw opened.error;
  const database = opened.value;

  const clock = new FixedClock(instant(1_787_443_200_000));
  return {
    database,
    clock,
    deps: {
      database,
      projects: new InMemoryProjectRepository(),
      series: new InMemorySeriesRepository(),
      runs: new DrizzleRunRepository(database),
      clock,
      logger: new NoopLogger(),
      workspaceDir,
    },
  };
}

/** Row counts for every table the seed writes. The idempotency assertion is this object. */
function counts(database: DatabaseHandle): Record<string, number> {
  const db = database.db;
  return {
    styleBibles: db.select().from(styleBibles).all().length,
    entities: db.select().from(entities).all().length,
    relations: db.select().from(relations).all().length,
    runs: db.select().from(runs).all().length,
    jobs: db.select().from(jobs).all().length,
  };
}

describe('seedDemo', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = build(WORKSPACE_DIR);
  });

  afterEach(() => {
    fixture.database.close();
  });

  describe('on an empty database', () => {
    it('creates the project and the series through their ports', async () => {
      const report = await seedDemo(fixture.deps);
      expect(isOk(report)).toBe(true);
      if (!isOk(report)) return;

      expect(report.value.alreadySeeded).toBe(false);
      expect(report.value.projectId).toBe(DEMO_PROJECT_ID);
      expect(report.value.seriesId).toBe(DEMO_SERIES_ID);

      const project = await fixture.deps.projects.findById(DEMO_PROJECT_ID);
      expect(isOk(project) && project.value !== null).toBe(true);
      // The project points at the style it was locked to; a project whose style is still
      // null renders nothing, which is the empty state the demo exists to replace.
      if (isOk(project)) expect(project.value?.styleBibleId).toBe(DEMO_STYLE_BIBLE_ID);

      const series = await fixture.deps.series.listByProject(DEMO_PROJECT_ID);
      expect(isOk(series) && series.value.length).toBe(1);
    });

    it('stores a locked style bible whose checksum is real', async () => {
      const report = await seedDemo(fixture.deps);
      expect(isOk(report)).toBe(true);

      const rows = fixture.database.db.select().from(styleBibles).all();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toBeDefined();
      if (row === undefined) return;

      const parsed = StyleBible.parse({
        id: row.id,
        name: row.name,
        version: row.version,
        origin: row.origin,
        ...(row.parentId === null ? {} : { parentId: row.parentId }),
        visual: row.visual,
        motion: row.motion,
        render: row.render,
        prompts: row.prompts,
        anchors: row.anchors,
        seed: row.seed,
        checksum: row.checksum,
        lockedAt: row.lockedAt,
        createdAt: row.createdAt,
        ...(row.notes === null ? {} : { notes: row.notes }),
      });

      expect(isLocked(parsed)).toBe(true);
      // The whole point: the checksum was computed from the content, not written by hand.
      expect(isChecksumValid(parsed)).toBe(true);
      expect(parsed.origin).toBe('preset');
    });

    it('stores three characters that round-trip Entity', async () => {
      const report = await seedDemo(fixture.deps);
      expect(isOk(report)).toBe(true);
      if (!isOk(report)) return;

      expect(report.value.entityIds).toEqual([DEMO_GOLAB_ID, DEMO_GOLNAR_ID, DEMO_FARHAD_ID]);

      const rows = fixture.database.db.select().from(entities).all();
      expect(rows).toHaveLength(3);

      for (const row of rows) {
        const parsed = Entity.parse({
          id: row.id,
          seriesId: row.seriesId,
          kind: row.kind,
          canonicalName: row.canonicalName,
          aliases: row.aliases,
          summary: row.summary,
          firstAppearance: {
            ordinal: row.firstAppearanceOrdinal,
            ...(row.firstAppearanceLabel === null ? {} : { label: row.firstAppearanceLabel }),
          },
          importance: row.importance,
          assetRefs: row.assetRefs,
          embedding: row.embedding ?? [],
          payload: row.payload,
        });

        expect(parsed.kind).toBe('character');
        expect(parsed.seriesId).toBe(DEMO_SERIES_ID);
        if (parsed.kind !== 'character') continue;
        // The psychology block is what the model was asked for and what the actor agent
        // reads; an entity that lost it is a portrait, not a character.
        expect(parsed.payload.psych.want.length).toBeGreaterThan(0);
        expect(parsed.payload.psych.lie.length).toBeGreaterThan(0);
      }
    });

    it('stores the epistemic pair: a secret edge and its believes-falsely counterpart', async () => {
      const report = await seedDemo(fixture.deps);
      expect(isOk(report)).toBe(true);
      if (!isOk(report)) return;

      const rows = fixture.database.db.select().from(relations).all();
      expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(report.value.relationIds).toHaveLength(rows.length);

      const parsed = rows.map((row) =>
        Relation.parse({
          id: row.id,
          seriesId: row.seriesId,
          from: row.fromEntityId,
          to: row.toEntityId,
          type: row.type,
          fact: row.fact,
          strength: row.strength,
          validFrom:
            row.validFromOrdinal === null
              ? null
              : {
                  ordinal: row.validFromOrdinal,
                  ...(row.validFromLabel === null ? {} : { label: row.validFromLabel }),
                },
          validUntil:
            row.validUntilOrdinal === null
              ? null
              : {
                  ordinal: row.validUntilOrdinal,
                  ...(row.validUntilLabel === null ? {} : { label: row.validUntilLabel }),
                },
          assertedAt: row.assertedAt,
          retractedAt: row.retractedAt,
          sourceRef: row.sourceRef,
          confidence: row.confidence,
          visibility: row.visibility,
        }),
      );

      const secret = parsed.filter((relation) => relation.visibility === 'secret');
      expect(secret).toHaveLength(1);
      expect(secret[0]?.type).toBe('witnessed');

      const falseBelief = parsed.filter((relation) => relation.type === 'believes-falsely');
      expect(falseBelief).toHaveLength(1);
      // The irony is between two different heads: the character holding the false belief
      // must not be the one who witnessed the truth.
      expect(falseBelief[0]?.from).not.toBe(secret[0]?.from);

      // A bounded interval, well-formed on the story clock, so the bi-temporal refinement
      // is exercised by stored data rather than only by the schema's own tests.
      const bounded = parsed.filter((relation) => relation.validUntil !== null);
      expect(bounded.length).toBeGreaterThanOrEqual(1);
      for (const relation of bounded) {
        expect(relation.validUntil?.ordinal ?? 0).toBeGreaterThanOrEqual(
          relation.validFrom?.ordinal ?? 0,
        );
      }
    });

    it('registers both mp4s as artefacts hung off a completed run', async () => {
      const report = await seedDemo(fixture.deps);
      expect(isOk(report)).toBe(true);
      if (!isOk(report)) return;

      expect(report.value.artifacts).toHaveLength(2);

      const master = report.value.artifacts.find((artifact) => artifact.kind === 'master');
      const delivery = report.value.artifacts.find((artifact) => artifact.kind === 'delivery');
      expect(master).toBeDefined();
      expect(delivery).toBeDefined();

      // The refinement in `RenderArtifact`, seen from the outside.
      expect(master?.format).toBeNull();
      expect(delivery?.format).toBe('shorts-9x16');

      expect(master?.path).toBe('demo/grove-16x9.mp4');
      expect(delivery?.path).toBe('demo/grove-9x16.mp4');

      // Measured, not recited: the hash and the byte length are recomputed here from the
      // same files, so a seed that recorded a remembered number fails.
      const masterBytes = readFileSync(join(WORKSPACE_DIR, 'demo', 'grove-16x9.mp4'));
      expect(master?.bytes).toBe(masterBytes.byteLength);
      expect(master?.sha256).toBe(sha256(masterBytes));
      expect(master?.size).toEqual({ width: 1280, height: 720 });
      expect(delivery?.size).toEqual({ width: 720, height: 1280 });
      for (const artifact of report.value.artifacts) {
        expect(artifact.frameCount).toBe(144);
        expect(artifact.durationMs).toBe(6000);
        expect(artifact.encode.fps).toBe(24);
        expect(artifact.encode.codec).toBe('h264');
      }

      // The job's FK is the only path from an artefact back to a project, so the run has
      // to exist and has to be finished for the demo to read as "this came out of a run".
      const jobRow = fixture.database.db.select().from(jobs).all()[0];
      expect(jobRow).toBeDefined();
      if (jobRow === undefined) return;

      const run = await fixture.deps.runs.findById(jobRow.runId);
      expect(isOk(run) && run.value?.status).toBe('succeeded');
      if (isOk(run)) {
        expect(run.value?.projectId).toBe(DEMO_PROJECT_ID);
        expect(run.value?.stages.map((stage) => stage.stage)).toEqual(['render']);
      }
    });

    it('stores a job whose payload and result both round-trip their schemas', async () => {
      const report = await seedDemo(fixture.deps);
      expect(isOk(report)).toBe(true);

      const rows = fixture.database.db.select().from(jobs).all();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toBeDefined();
      if (row === undefined) return;

      const job = RenderJob.parse(row.payload);
      expect(job.state).toBe('succeeded');
      expect(job.request.projectId).toBe(DEMO_PROJECT_ID);
      expect(job.runId).toBe(row.runId);

      const stored = z.object({ artifacts: z.array(RenderArtifact) }).parse(row.result);
      expect(stored.artifacts).toHaveLength(2);
    });
  });

  describe('run twice', () => {
    it('writes nothing the second time, even with the clock moved on', async () => {
      const first = await seedDemo(fixture.deps);
      expect(isOk(first)).toBe(true);
      if (!isOk(first)) return;
      expect(first.value.alreadySeeded).toBe(false);

      const after = counts(fixture.database);
      // Idempotency must not depend on the two runs agreeing about what time it is.
      fixture.clock.advance(86_400_000);

      const second = await seedDemo(fixture.deps);
      expect(isOk(second)).toBe(true);
      if (!isOk(second)) return;

      expect(second.value.alreadySeeded).toBe(true);
      expect(counts(fixture.database)).toEqual(after);

      // Same ids, same artefacts - a second call is a read, not a fork.
      expect(second.value.entityIds).toEqual(first.value.entityIds);
      expect(second.value.relationIds).toEqual(first.value.relationIds);
      expect(second.value.artifacts.map((artifact) => artifact.sha256)).toEqual(
        first.value.artifacts.map((artifact) => artifact.sha256),
      );

      const projects = await fixture.deps.projects.list();
      expect(isOk(projects) && projects.value.length).toBe(1);
    });

    it('heals a run left unfinished by a crashed first boot', async () => {
      const first = await seedDemo(fixture.deps);
      expect(isOk(first)).toBe(true);

      const row = fixture.database.db.select().from(runs).all()[0];
      expect(row).toBeDefined();
      if (row === undefined) return;

      // Rewind the run to the state a process killed between `create` and `setStatus`
      // would have left behind. Written straight to the row rather than through
      // `setStatus`, because `succeeded -> running` is not a transition the state
      // machine has - which is the point: a crash does not transition anything, it
      // simply stops, and the row is left saying `running` with no worker behind it.
      fixture.database.sqlite
        .prepare("update runs set state = 'running', finished_at = null where id = ?")
        .run(row.id);
      fixture.database.sqlite
        .prepare(
          "update runs set metadata = json_set(metadata, '$.status', 'running') where id = ?",
        )
        .run(row.id);

      const second = await seedDemo(fixture.deps);
      expect(isOk(second)).toBe(true);
      if (!isOk(second)) return;

      // Something *was* written, so this is honestly not a no-op run.
      expect(second.value.alreadySeeded).toBe(false);
      expect(counts(fixture.database).runs).toBe(1);

      const healed = await fixture.deps.runs.findById(row.id);
      expect(isOk(healed) && healed.value?.status).toBe('succeeded');
    });
  });

  describe('when a demo render is missing', () => {
    let emptyWorkspace: string;
    let empty: Fixture;

    beforeEach(() => {
      emptyWorkspace = mkdtempSync(join(tmpdir(), 'rivayat-seed-'));
      empty = build(emptyWorkspace);
    });

    afterEach(() => {
      empty.database.close();
      rmSync(emptyWorkspace, { recursive: true, force: true });
    });

    it('reports it as a Result, names the file, and writes nothing', async () => {
      const report = await seedDemo(empty.deps);

      expect(isErr(report)).toBe(true);
      if (!isErr(report)) return;

      expect(report.error.kind).toBe('not-found');
      expect(report.error.context.id).toBe('demo/grove-16x9.mp4');
      expect(report.error.context.workspaceDir).toBe(emptyWorkspace);

      // Not a silently-empty artefact list, and not a half-seeded database either: the
      // media is verified before the first insert.
      expect(counts(empty.database)).toEqual({
        styleBibles: 0,
        entities: 0,
        relations: 0,
        runs: 0,
        jobs: 0,
      });
      const projects = await empty.deps.projects.list();
      expect(isOk(projects) && projects.value.length).toBe(0);
    });
  });
});
