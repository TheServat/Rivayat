/**
 * One believable demo, produced by the real use-cases and validated by the real schemas.
 *
 * The owner opens the studio and every screen is empty. An empty studio teaches nothing
 * about what the product does, and a hand-written JSON blob that happens to parse
 * teaches worse than nothing - it shows a shape the pipeline never produced. So every
 * record here goes through the same door a real one would: `CreateProjectUseCase` mints
 * the project, `materialiseStyleBible` + `lock` produce the bible and its **real**
 * checksum, `Entity`/`Relation`/`RenderArtifact`/`RenderJob` all parse before anything is
 * stored, and the two mp4s are read off disk, hashed, and measured with `ffprobe` rather
 * than described from memory.
 *
 * ## Why it is idempotent, and how
 *
 * A seed that runs at boot runs on every boot. Every id here is therefore **fixed and
 * hard-coded**, parsed through its branded schema at module load: `Ids`/ULID is
 * time-and-randomness based, so minting ids would make the second boot produce a second
 * copy of the whole demo. Presence of the project id is the "already seeded" probe, and
 * every insert is conflict-safe on top of that, so a half-finished first run heals on the
 * second rather than failing on a primary key.
 *
 * ## Where each record lives, and why the answer differs
 *
 * **The project and the series go through their ports and nowhere else, and that is
 * correct rather than a shortcut.** `@rv/persistence` has no `projects` and no `series`
 * table - `runs.project_id` is a bare column with no referent - so `ProjectRepository`
 * and `SeriesRepository` are the only definition of where a project lives, and the
 * composition root decides what is behind them. This file must not know or care which
 * adapter that is: seeding through the port puts the demo exactly where the running
 * application keeps projects, whatever that is today, and the day the migration lands
 * this file does not change at all.
 *
 * **The artefacts live in `jobs`, because there is no `render_jobs` table and this app may
 * not add a migration to a package another workstream owns.** `jobs.payload` is documented
 * as "a `RenderJob` lives here unchanged" and `jobs.result` as "checkpoints and artefacts
 * live here", and `jobs.run_id -> runs.id -> runs.project_id` is the only path there is
 * from an artefact back to a project. So the demo creates a completed run through
 * `RunRepository` and hangs one finished render job off it.
 *
 * **There is no episode.** `EpisodeRepository` is read-only - nothing in the API writes an
 * episode, because S2 Story is bound to a stub - and an `EpisodeOutline` is an act/beat
 * structure that only S2 can honestly produce. Inserting one directly would be the
 * hand-written blob this file exists to avoid, so the demo stops at the cast and the
 * render, both of which really were produced by `rv character` and `rv animate`.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  Entity,
  EntityId,
  Ids,
  JobId,
  ProjectId,
  Relation,
  RelationId,
  RenderArtifact,
  RenderJob,
  RunId,
  SeriesId,
  StyleBibleId,
  type AnimationId,
  type IsoInstant,
  type StyleBible,
} from '@rv/contracts';
import { lock } from '@rv/core-domain';
import { entities, jobs, relations, styleBibles, type DatabaseHandle } from '@rv/persistence';
import { findPreset, materialiseStyleBible } from '@rv/style-engine';
import {
  IdGenerator,
  NotFoundError,
  ValidationError,
  err,
  fromThrowable,
  isErr,
  ok,
  sha256,
  toIso,
  type Clock,
  type Logger,
  type Result,
} from '@rv/shared-kernel';
import { z } from 'zod';

import type {
  ProjectRepository,
  RunRepository,
  SeriesRepository,
} from '../../application/ports/repository.ports';
import { RunStageResult, RunSummary, SeriesCard } from '../../application/resources';
import { CreateProjectUseCase } from '../../modules/projects/create-project.use-case';
import { DEMO_CHARACTERS, DEMO_GOLNAR_ID, DEMO_GOLAB_ID, DEMO_FARHAD_ID } from './demo-characters';

// ── the fixed identity of the demo ──────────────────────────────────────────

/**
 * Hard-coded ids, parsed rather than cast.
 *
 * The bodies are legal Crockford base32 (`0DEM0GR0VE…` - no I, L, O or U) so they read as
 * "demo grove" in a log line while still satisfying `ProjectId` and friends. Parsing them
 * here means a typo is a module-load failure in this repository's own source, which is
 * where programmer error belongs, rather than a confusing insert failure at boot.
 */
export const DEMO_PROJECT_ID: ProjectId = ProjectId.parse('prj_0DEM0GR0VE0000000000000001');
export const DEMO_SERIES_ID: SeriesId = SeriesId.parse('ser_0DEM0GR0VE0000000000000002');
export const DEMO_STYLE_BIBLE_ID: StyleBibleId = StyleBibleId.parse(
  'sty_0DEM0GR0VE0000000000000003',
);
const DEMO_RUN_ID: RunId = RunId.parse('run_0DEM0GR0VE0000000000000030');
const DEMO_JOB_ID: JobId = JobId.parse('job_0DEM0GR0VE0000000000000031');

/**
 * The animation the render job points at.
 *
 * `rv animate` builds its grove scene in code (`apps/cli/src/commands/animate.ts`) and
 * never persists an `AnimationIR`, so this id refers to that authored scene by convention.
 * It is typed rather than parsed because `AnimationId` is only ever carried, never looked
 * up - there is no animations table to miss.
 */
const DEMO_ANIMATION_ID = 'anm_0DEM0GR0VE0000000000000032' as AnimationId;

/** The style the whole demo is locked to. One of the eleven presets in `@rv/style-engine`. */
const DEMO_STYLE_PRESET_ID = 'paper-cutout';

/**
 * The run's seed, which is the preset's seed.
 *
 * Not an arbitrary number: a run replayed against this style must make the same
 * deterministic choices the style itself was built from, and reusing the preset's seed is
 * the cheapest way to say so in data.
 */
const DEMO_RUN_SEED = 202_202;

// ── the two rendered videos ─────────────────────────────────────────────────

/**
 * What `ffprobe` reported for each file on 2026-08-23, kept as the fallback.
 *
 * These are used **only** when `ffprobe` cannot be run. The byte length is always taken
 * from the file itself, so a swapped file is recorded truthfully even in the fallback
 * path; everything else here is the measurement, written down.
 */
interface DemoRenderSpec {
  /** Path relative to the workspace root. `RenderArtifact.path` is never absolute. */
  readonly path: string;
  readonly kind: 'master' | 'delivery';
  /** `null` for the master, which belongs to no single format. See `RenderArtifact`. */
  readonly format: 'shorts-9x16' | null;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly durationMs: number;
  /** Byte length as committed. A mismatch is logged, never asserted. */
  readonly expectedBytes: number;
}

/**
 * The frame rate `rv animate` renders and encodes at, from its own `AnimationIR`.
 *
 * 24, not the 30 every `FormatProfile` declares: the demo is an authored scene rather
 * than a delivery, and recording the profile's frame rate for a file encoded at another
 * would make the artefact lie about itself.
 */
const DEMO_FPS = 24;

/**
 * x264's default `keyint`, in frames.
 *
 * `rv animate` passes no `-g`, and `ffprobe` finds exactly one keyframe in the whole
 * 144-frame clip - consistent with this default and inconsistent with anything shorter
 * than the clip. Recording the schema's 2-second default instead would be a number nobody
 * measured.
 */
const X264_DEFAULT_KEYINT_FRAMES = 250;

/**
 * The two files, in the order the pipeline thinks of them.
 *
 * The 16:9 render is the **master**: it is the full-frame, format-agnostic pass the
 * vertical cut is framed from (architecture §7 renders once and re-frames per format), and
 * `RenderArtifact`'s refinement requires a master to carry `format: null`. The 9:16 render
 * is the **delivery**, and the same refinement requires it to name the format it was cut
 * for. Its 720×1280 is the demo's reduced resolution, not `shorts-9x16`'s 1080×1920 - the
 * measurement wins over the profile, because the artefact describes the file that exists.
 */
const DEMO_RENDERS: readonly DemoRenderSpec[] = [
  {
    path: 'demo/grove-16x9.mp4',
    kind: 'master',
    format: null,
    width: 1280,
    height: 720,
    frameCount: 144,
    durationMs: 6000,
    expectedBytes: 91_768,
  },
  {
    path: 'demo/grove-9x16.mp4',
    kind: 'delivery',
    format: 'shorts-9x16',
    width: 720,
    height: 1280,
    frameCount: 144,
    durationMs: 6000,
    expectedBytes: 150_241,
  },
];

/**
 * The encode `rv animate` actually ran, field for field.
 *
 * `-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p`, no audio stream at all (which is
 * why `audioCodec` is `none`), and 24 fps from the IR. Recorded on the artefact because an
 * export has to be reproducible from its own record.
 */
function demoEncodeSettings(): Record<string, unknown> {
  return {
    codec: 'h264',
    container: 'mp4',
    rateControl: { mode: 'crf', crf: 18 },
    pixelFormat: 'yuv420p',
    colorRange: 'limited',
    fps: DEMO_FPS,
    gopSeconds: X264_DEFAULT_KEYINT_FRAMES / DEMO_FPS,
    audioCodec: 'none',
  };
}

// ── deps and report ─────────────────────────────────────────────────────────

export interface DemoSeedDeps {
  readonly database: DatabaseHandle;
  readonly projects: ProjectRepository;
  readonly series: SeriesRepository;
  readonly runs: RunRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Absolute workspace root; the demo mp4s live under it. */
  readonly workspaceDir: string;
}

export interface DemoSeedReport {
  readonly projectId: ProjectId;
  readonly seriesId: SeriesId;
  readonly styleBibleId: StyleBibleId;
  readonly entityIds: readonly EntityId[];
  readonly relationIds: readonly RelationId[];
  readonly artifacts: readonly RenderArtifact[];
  /** True when nothing had to be written because it was all already there. */
  readonly alreadySeeded: boolean;
}

// ── parsing at the boundary ─────────────────────────────────────────────────

/**
 * Parse, and turn a parse failure into a `Result` instead of a throw.
 *
 * `Entity.parse` and friends throw, which is right for a contract violation inside the
 * domain and wrong here: a malformed seed record is something the operator has to be told
 * about at boot, on the same channel as a missing file, not a stack trace out of Zod. The
 * issue paths are carried through because "invalid input" with no field name costs an hour.
 */
function parseOrFail<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  what: string,
): Result<z.output<TSchema>> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return ok(parsed.data);
  return err(
    new ValidationError({
      message: `The demo seed built a ${what} that does not satisfy its own schema`,
      context: {
        what,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        ),
      },
    }),
  );
}

/** `better-sqlite3` is synchronous, so a failing statement throws. This is the boundary. */
function attempt<T>(message: string, fn: () => T): Result<T> {
  return fromThrowable(fn, (caught) => {
    if (caught instanceof Error) {
      return new ValidationError({ message, context: { reason: caught.message }, cause: caught });
    }
    return new ValidationError({ message, context: { reason: String(caught) } });
  });
}

/**
 * `Ids` with the project id pinned.
 *
 * `CreateProjectUseCase` mints its own id, which is exactly what it should do for a real
 * project and exactly what breaks a re-runnable seed. Overriding the one method keeps the
 * use-case on its real path - clock, schema, repository - while making the id fixed. The
 * generator is built over the injected clock so nothing here reaches for `SystemClock`.
 */
class PinnedIds extends Ids {
  constructor(clock: Clock) {
    super(new IdGenerator(clock));
  }

  override project(): ProjectId {
    return DEMO_PROJECT_ID;
  }
}

// ── media ───────────────────────────────────────────────────────────────────

interface MeasuredRenders {
  readonly artifacts: readonly RenderArtifact[];
  /** True when `ffprobe` ran and its numbers were used. False means the recorded encode. */
  readonly probed: boolean;
}

interface ProbedStream {
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly durationMs: number;
}

const execFileAsync = promisify(execFile);

/**
 * What `ffprobe -of json` gives back, narrowed to the four numbers we use.
 *
 * `nb_frames` and `duration` arrive as strings from ffprobe's JSON writer, which is why
 * they are parsed rather than read.
 */
const FfprobeOutput = z.object({
  streams: z
    .array(
      z.object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        nb_frames: z.string().optional(),
        duration: z.string().optional(),
      }),
    )
    .min(1),
  format: z.object({ duration: z.string().optional() }).optional(),
});

/**
 * The real duration, size and frame count, or `null` when ffprobe is unavailable.
 *
 * Never a throw and never a partial answer: a missing binary, a timeout and unparseable
 * output all mean the same thing to the caller - "fall back to the recorded encode" - and
 * the caller reports which of the two it used.
 */
async function probe(ffprobePath: string, absolutePath: string): Promise<ProbedStream | null> {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,nb_frames,duration',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        absolutePath,
      ],
      { timeout: 10_000, windowsHide: true },
    );

    const parsed = FfprobeOutput.safeParse(JSON.parse(stdout));
    if (!parsed.success) return null;

    const stream = parsed.data.streams[0];
    if (stream === undefined) return null;

    const seconds = Number(stream.duration ?? parsed.data.format?.duration ?? '');
    const frames = Number(stream.nb_frames ?? '');
    if (!Number.isFinite(seconds) || !Number.isInteger(frames) || frames <= 0) return null;

    return {
      width: stream.width,
      height: stream.height,
      frameCount: frames,
      durationMs: Math.round(seconds * 1000),
    };
  } catch {
    return null;
  }
}

/**
 * Reads both mp4s, hashes them, and builds one `RenderArtifact` each.
 *
 * Deliberately the **first** thing `seedDemo` does. A missing file is the one failure this
 * seed genuinely expects - the demo renders are committed under `workspace/`, and a fresh
 * clone with a different workspace root will not have them - so it is reported before a
 * single row is written rather than after half of them are.
 */
async function measureRenders(
  deps: DemoSeedDeps,
  now: IsoInstant,
): Promise<Result<MeasuredRenders>> {
  const ffprobePath = process.env.RV_FFPROBE_PATH ?? 'ffprobe';
  const artifacts: RenderArtifact[] = [];
  let probedAll = true;

  for (const spec of DEMO_RENDERS) {
    const absolutePath = join(deps.workspaceDir, ...spec.path.split('/'));

    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch (caught) {
      return err(
        new NotFoundError('demo render', spec.path, {
          cause: caught,
          context: { absolutePath, workspaceDir: deps.workspaceDir },
        }),
      );
    }

    if (bytes.byteLength !== spec.expectedBytes) {
      deps.logger.warn('Demo render is not the committed file; recording what is on disk', {
        path: spec.path,
        expectedBytes: spec.expectedBytes,
        actualBytes: bytes.byteLength,
      });
    }

    const measured = await probe(ffprobePath, absolutePath);
    if (measured === null) probedAll = false;

    const artifact = parseOrFail(
      RenderArtifact,
      {
        kind: spec.kind,
        format: spec.format,
        path: spec.path,
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
        durationMs: measured?.durationMs ?? spec.durationMs,
        size: {
          width: measured?.width ?? spec.width,
          height: measured?.height ?? spec.height,
        },
        frameCount: measured?.frameCount ?? spec.frameCount,
        encode: demoEncodeSettings(),
        createdAt: now,
      },
      `render artefact for ${spec.path}`,
    );
    if (isErr(artifact)) return artifact;
    artifacts.push(artifact.value);
  }

  return ok({ artifacts, probed: probedAll });
}

// ── the narrative graph ─────────────────────────────────────────────────────

/**
 * The five edges, written so the epistemic layer has something to show.
 *
 * One is `secret` - the audience has not been shown that Golnar saw the well sealed - and
 * one is `believes-falsely`, and they are a matched pair on purpose: the gap between what
 * is true (edge 3) and what Farhad holds to be true (edge 4) is the whole dramatic irony
 * budget of the demo, and it is data rather than subtext. `sourceRef` is `author` on all
 * five because a human wrote this graph; an extractor would have written `episode` and a
 * lower `confidence`.
 */
function demoRelations(assertedAt: IsoInstant): readonly unknown[] {
  const authored = { kind: 'author', note: 'نوشتهٔ نویسنده برای نمونهٔ اولیهٔ باغ انار.' };

  return [
    {
      id: 'rel_0DEM0GR0VE0000000000000020',
      seriesId: DEMO_SERIES_ID,
      from: DEMO_GOLAB_ID,
      to: DEMO_GOLNAR_ID,
      type: 'mentor-of',
      fact: 'بی‌بی گلاب به گلنار یاد می‌دهد کدام درخت تشنه است و کدام فقط بهانه می‌گیرد.',
      strength: 0.6,
      validFrom: { ordinal: 20, label: 'قسمت ۲ — پس از شب دزدی' },
      validUntil: null,
      assertedAt,
      retractedAt: null,
      sourceRef: authored,
      confidence: 1,
      visibility: 'public',
    },
    {
      id: 'rel_0DEM0GR0VE0000000000000021',
      seriesId: DEMO_SERIES_ID,
      from: DEMO_GOLNAR_ID,
      to: DEMO_GOLAB_ID,
      type: 'trusts',
      // A bounded story-time interval, so the bi-temporal ordering is exercised rather
      // than merely declared: the trust starts in episode 2 and ends in episode 4.
      fact: 'گلنار به بی‌بی گلاب اعتماد می‌کند، تا شبی که می‌بیند پیرزن دربارهٔ چاه دروغ می‌گوید.',
      strength: 0.8,
      validFrom: { ordinal: 20, label: 'قسمت ۲' },
      validUntil: { ordinal: 45, label: 'قسمت ۴ — شب اعتراف' },
      assertedAt,
      retractedAt: null,
      sourceRef: authored,
      confidence: 1,
      visibility: 'public',
    },
    {
      id: 'rel_0DEM0GR0VE0000000000000022',
      seriesId: DEMO_SERIES_ID,
      from: DEMO_GOLNAR_ID,
      to: DEMO_GOLAB_ID,
      type: 'witnessed',
      fact: 'گلنار از بالای دیوار دیده است که بی‌بی گلاب شبانه دهانهٔ چاه را با سنگ و گِل مهر کرد.',
      strength: 1,
      validFrom: { ordinal: 10, label: 'قسمت ۱ — شب اول' },
      validUntil: null,
      assertedAt,
      retractedAt: null,
      sourceRef: authored,
      confidence: 1,
      // The one thing neither the cast nor the audience has been told yet.
      visibility: 'secret',
    },
    {
      id: 'rel_0DEM0GR0VE0000000000000023',
      seriesId: DEMO_SERIES_ID,
      from: DEMO_FARHAD_ID,
      to: DEMO_GOLAB_ID,
      type: 'believes-falsely',
      fact: 'میرزا فرهاد باور دارد چاه باغ سال‌هاست خشک شده و بی‌بی گلاب تنها از سرِ عادت از آن نگهبانی می‌کند.',
      strength: 0.9,
      validFrom: { ordinal: 30, label: 'قسمت ۳ — ورود مهندس' },
      validUntil: null,
      assertedAt,
      retractedAt: null,
      sourceRef: authored,
      confidence: 1,
      visibility: 'public',
    },
    {
      id: 'rel_0DEM0GR0VE0000000000000024',
      seriesId: DEMO_SERIES_ID,
      from: DEMO_GOLAB_ID,
      to: DEMO_FARHAD_ID,
      type: 'fears',
      fact: 'بی‌بی گلاب از میرزا فرهاد می‌ترسد، نه از قدرتش، که از مهربانی بی‌خبرش.',
      strength: 0.7,
      validFrom: { ordinal: 30, label: 'قسمت ۳ — ورود مهندس' },
      validUntil: null,
      assertedAt,
      retractedAt: null,
      sourceRef: authored,
      confidence: 1,
      visibility: 'public',
    },
  ];
}

// ── the seed ────────────────────────────────────────────────────────────────

/**
 * Seeds the demo, once.
 *
 * Returns `alreadySeeded: true` when nothing had to be written. Reading and hashing the
 * two mp4s happens on every call regardless - that is a verification, not a write - so a
 * demo file that has gone missing is reported on the second boot as loudly as on the first.
 */
export async function seedDemo(deps: DemoSeedDeps): Promise<Result<DemoSeedReport>> {
  const now: IsoInstant = toIso(deps.clock.now());

  const renders = await measureRenders(deps, now);
  if (isErr(renders)) return renders;

  let wrote = false;

  // ── project ───────────────────────────────────────────────────────────────
  const existingProject = await deps.projects.findById(DEMO_PROJECT_ID);
  if (isErr(existingProject)) return existingProject;

  let project = existingProject.value;
  if (project === null) {
    const created = await new CreateProjectUseCase({
      repository: deps.projects,
      clock: deps.clock,
      ids: new PinnedIds(deps.clock),
    }).execute({
      name: 'حکایت‌های باغ انار',
      description:
        'یک مجموعهٔ کوتاه بر پایهٔ افسانه‌های شفاهی کویر: باغی دیواربسته، چاهی که کسی حق برداشتن از آن را ندارد، و سه نفر که هر کدام بخشی از حقیقت را می‌دانند. این پروژه نمونهٔ آماده‌ای است تا استودیو از روز اول خالی نباشد.',
      budgetNanoUsd: null,
    });
    if (isErr(created)) return created;
    project = created.value;
    wrote = true;
  }

  // ── series ────────────────────────────────────────────────────────────────
  const seriesCard = parseOrFail(
    SeriesCard,
    {
      id: DEMO_SERIES_ID,
      projectId: DEMO_PROJECT_ID,
      title: 'نگهبان چاه',
      premise:
        'بی‌بی گلاب چهل سال است تنها باغ انار را آب می‌دهد و به هیچ‌کس اجازهٔ نزدیک شدن به چاه را نمی‌دهد. دخترکی که شب‌ها از دیوار بالا می‌رود چیزی دیده که نباید، و مهندسی مؤدب از پایتخت آمده تا همان چاه را اندازه بگیرد و به نام کانال بزند.',
      hasBible: false,
      createdAt: now,
    },
    'series card',
  );
  if (isErr(seriesCard)) return seriesCard;

  const existingSeries = await deps.series.findById(DEMO_SERIES_ID);
  if (isErr(existingSeries)) return existingSeries;
  if (existingSeries.value === null) {
    const created = await deps.series.create(seriesCard.value);
    if (isErr(created)) return created;
    wrote = true;
  }

  // ── style bible ───────────────────────────────────────────────────────────
  const preset = findPreset(DEMO_STYLE_PRESET_ID);
  if (isErr(preset)) return preset;

  // `materialiseStyleBible` computes the checksum from `visual`/`motion`/`render`/
  // `prompts`/`seed` only, so it is a pure function of the preset - re-running under a
  // different clock produces the identical checksum, which is what makes the row below
  // safe to leave untouched on conflict.
  const locked = lock(
    materialiseStyleBible({
      draft: preset.value.draft,
      id: DEMO_STYLE_BIBLE_ID,
      clock: deps.clock,
    }),
    now,
  );
  if (isErr(locked)) return locked;

  // ── the cast ──────────────────────────────────────────────────────────────
  const cast: Entity[] = [];
  for (const sheet of DEMO_CHARACTERS) {
    const entity = parseOrFail(
      Entity,
      {
        id: sheet.id,
        seriesId: DEMO_SERIES_ID,
        kind: 'character',
        canonicalName: sheet.canonicalName,
        aliases: sheet.aliases,
        summary: sheet.summary,
        firstAppearance: sheet.firstAppearance,
        importance: sheet.importance,
        assetRefs: sheet.assetRefs,
        embedding: [],
        payload: sheet.payload,
      },
      `character entity ${sheet.canonicalName}`,
    );
    if (isErr(entity)) return entity;
    cast.push(entity.value);
  }

  // ── the edges ─────────────────────────────────────────────────────────────
  const edges: Relation[] = [];
  for (const candidate of demoRelations(now)) {
    const relation = parseOrFail(Relation, candidate, 'relation');
    if (isErr(relation)) return relation;
    edges.push(relation.value);
  }

  // One transaction: entities must exist before their edges, `foreign_keys` is ON, and a
  // crash between the two halves would leave a graph that cannot be read back.
  const graphWrites = attempt('Could not write the demo narrative graph', () =>
    deps.database.db.transaction(
      (tx) => {
        let changes = 0;

        changes += tx
          .insert(styleBibles)
          .values(styleBibleRow(locked.value))
          .onConflictDoNothing({ target: styleBibles.id })
          .run().changes;

        for (const entity of cast) {
          changes += tx
            .insert(entities)
            .values({
              id: entity.id,
              seriesId: entity.seriesId,
              kind: entity.kind,
              canonicalName: entity.canonicalName,
              aliases: [...entity.aliases],
              summary: entity.summary,
              firstAppearanceOrdinal: entity.firstAppearance.ordinal,
              firstAppearanceLabel: entity.firstAppearance.label ?? null,
              importance: entity.importance,
              assetRefs: [...entity.assetRefs],
              payload: entity.payload,
            })
            .onConflictDoNothing({ target: entities.id })
            .run().changes;
        }

        for (const edge of edges) {
          changes += tx
            .insert(relations)
            .values({
              id: edge.id,
              seriesId: edge.seriesId,
              fromEntityId: edge.from,
              toEntityId: edge.to,
              type: edge.type,
              fact: edge.fact,
              strength: edge.strength,
              validFromOrdinal: edge.validFrom?.ordinal ?? null,
              validFromLabel: edge.validFrom?.label ?? null,
              validUntilOrdinal: edge.validUntil?.ordinal ?? null,
              validUntilLabel: edge.validUntil?.label ?? null,
              assertedAt: edge.assertedAt,
              retractedAt: edge.retractedAt,
              sourceRef: edge.sourceRef,
              confidence: edge.confidence,
              visibility: edge.visibility,
            })
            .onConflictDoNothing({ target: relations.id })
            .run().changes;
        }

        return changes;
      },
      { behavior: 'immediate' },
    ),
  );
  if (isErr(graphWrites)) return graphWrites;
  if (graphWrites.value > 0) wrote = true;

  // The project points at its locked style once there is one. Guarded, so the second run
  // does not write a row that already says this.
  if (project.styleBibleId === null) {
    const updated = await deps.projects.update(
      DEMO_PROJECT_ID,
      { styleBibleId: DEMO_STYLE_BIBLE_ID },
      now,
    );
    if (isErr(updated)) return updated;
    wrote = true;
  }

  // ── the run that produced the videos ──────────────────────────────────────
  const existingRun = await deps.runs.findById(DEMO_RUN_ID);
  if (isErr(existingRun)) return existingRun;

  if (existingRun.value === null) {
    const summary = parseOrFail(
      RunSummary,
      {
        id: DEMO_RUN_ID,
        projectId: DEMO_PROJECT_ID,
        seriesId: DEMO_SERIES_ID,
        status: 'running',
        requestedStages: ['render'],
        currentStage: 'render',
        stages: [],
        seed: DEMO_RUN_SEED,
        budgetNanoUsd: null,
        // Zero is the truth, not a placeholder: `rv animate` is local ffmpeg over an
        // authored scene and spends nothing.
        spentNanoUsd: 0,
        errorCode: null,
        startedAt: now,
        finishedAt: null,
      },
      'run summary',
    );
    if (isErr(summary)) return summary;

    const created = await deps.runs.create(summary.value);
    if (isErr(created)) return created;

    const stage = parseOrFail(
      RunStageResult,
      {
        stage: 'render',
        status: 'succeeded',
        costNanoUsd: 0,
        // `durationMs` is left at its default. `rv animate` printed an elapsed time to the
        // terminal and stored it nowhere, so any number here would be invented.
        artifacts: renders.value.artifacts.map((artifact) => `render-artifact:${artifact.path}`),
        errorCode: null,
      },
      'run stage result',
    );
    if (isErr(stage)) return stage;

    const recorded = await deps.runs.recordStage(DEMO_RUN_ID, stage.value);
    if (isErr(recorded)) return recorded;

    const finished = await deps.runs.setStatus(DEMO_RUN_ID, 'succeeded', now);
    if (isErr(finished)) return finished;
    wrote = true;
  } else if (existingRun.value.status !== 'succeeded') {
    // A previous boot died between `create` and `setStatus`. Heal rather than duplicate.
    const finished = await deps.runs.setStatus(DEMO_RUN_ID, 'succeeded', now);
    if (isErr(finished)) return finished;
    wrote = true;
  }

  // ── the render job the artefacts hang off ─────────────────────────────────
  const renderJob = parseOrFail(
    RenderJob,
    {
      id: DEMO_JOB_ID,
      runId: DEMO_RUN_ID,
      request: {
        projectId: DEMO_PROJECT_ID,
        animationId: DEMO_ANIMATION_ID,
        episodeId: null,
        formats: ['shorts-9x16'],
        quality: 'preview',
        frames: null,
        // `rv animate` draws into `@napi-rs/canvas`, not a browser.
        backend: 'napi-canvas',
        concurrency: 1,
        writeIntermediateFrames: false,
        encodeOverrides: {},
      },
      state: 'succeeded',
      shard: null,
      checkpoint: {
        completedRanges: [{ from: 0, to: DEMO_RENDERS[0]?.frameCount ?? 144 }],
        lastCompletedFrame: (DEMO_RENDERS[0]?.frameCount ?? 144) - 1,
        // Null, not a fabricated hash. A resumed worker compares this against a
        // re-evaluated frame; inventing one would make it splice two different films.
        lastFrameHash: null,
        updatedAt: now,
      },
      progress: {
        jobId: DEMO_JOB_ID,
        phase: 'finalising',
        framesDone: DEMO_RENDERS[0]?.frameCount ?? 144,
        framesTotal: DEMO_RENDERS[0]?.frameCount ?? 144,
        fraction: 1,
        etaMs: 0,
        // Left at zero: throughput was never recorded, and zero reads as "not measured"
        // in a field the schema calls diagnostic.
        currentFormat: 'shorts-9x16',
      },
      // Empty on purpose. `jobs.result` is documented as where artefacts live, and two
      // copies of the same list is two copies that can drift.
      artifacts: [],
      errorCode: null,
      createdAt: now,
      updatedAt: now,
    },
    'render job',
  );
  if (isErr(renderJob)) return renderJob;

  const jobWrite = attempt('Could not write the demo render job', () =>
    deps.database.db
      .insert(jobs)
      .values({
        id: DEMO_JOB_ID,
        runId: DEMO_RUN_ID,
        stage: 'render',
        state: 'succeeded',
        attempt: 1,
        payload: renderJob.value,
        result: { artifacts: renders.value.artifacts },
        errorCode: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: jobs.id })
      .run(),
  );
  if (isErr(jobWrite)) return jobWrite;
  if (jobWrite.value.changes > 0) wrote = true;

  const report: DemoSeedReport = {
    projectId: DEMO_PROJECT_ID,
    seriesId: DEMO_SERIES_ID,
    styleBibleId: DEMO_STYLE_BIBLE_ID,
    entityIds: cast.map((entity) => entity.id),
    relationIds: edges.map((edge) => edge.id),
    artifacts: renders.value.artifacts,
    alreadySeeded: !wrote,
  };

  deps.logger.info(wrote ? 'Seeded the grove demo' : 'Grove demo was already seeded', {
    projectId: report.projectId,
    seriesId: report.seriesId,
    styleBibleId: report.styleBibleId,
    entities: report.entityIds.length,
    relations: report.relationIds.length,
    artifacts: report.artifacts.length,
    // Says which of the two measurement paths the artefact numbers came from, so nobody
    // has to guess whether the durations were probed or recalled.
    renderMeasurement: renders.value.probed ? 'ffprobe' : 'recorded encode',
  });

  return ok(report);
}

/**
 * The bible, shredded into the columns `style_bibles` actually has.
 *
 * `parentId` and `notes` are optional on the contract and nullable in the column, so the
 * two absent forms are converted here rather than at three call sites.
 */
function styleBibleRow(bible: StyleBible): typeof styleBibles.$inferInsert {
  return {
    id: bible.id,
    name: bible.name,
    version: bible.version,
    origin: bible.origin,
    parentId: bible.parentId ?? null,
    visual: bible.visual,
    motion: bible.motion,
    render: bible.render,
    prompts: bible.prompts,
    anchors: [...bible.anchors],
    seed: bible.seed,
    checksum: bible.checksum,
    lockedAt: bible.lockedAt,
    createdAt: bible.createdAt,
    notes: bible.notes ?? null,
  };
}
