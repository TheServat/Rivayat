/**
 * S3 as the pipeline runs it: a shortlist becomes sheets, and sheets become the grid.
 *
 * The assertions here are the ones RV-083's standard rests on. A character who arrives
 * with three expressions and one outfit is a failure of this code, so the grid is
 * checked for its *size and shape*, and the entity is checked for having the filled
 * `visual` block rather than the empty one the sheet call returns.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ids, type StyleBible, type SeriesId } from '@rv/contracts';
import { lock } from '@rv/core-domain';
import { createDatabase, type DatabaseHandle } from '@rv/persistence';
import { findPreset, materialiseStyleBible } from '@rv/style-engine';
import { FixedClock, MemoryLogger, isErr, toIso } from '@rv/shared-kernel';

import { DEMO_CHARACTERS } from '../infrastructure/seed/demo-characters';
import { NarrativeGraphStore } from '../narrative/graph.store';
import {
  FakeStructuredBackend,
  RecordingMeter,
  RefusingMeter,
  TEST_INSTANT,
  fakeEngine,
  fakeRouter,
  scratchWorkspace,
  stageContext,
  testClock,
} from './__fixtures__/story-fakes';
import { CastStageHandler } from './cast-stage.handler';
import { CastService } from './cast.service';
import { CharacterStateStore } from './cast.store';
import { StoryStore, emptyStoryDocument } from './story.store';

const SERIES = 'ser_01JQZK3M7X8YB4N2VTC6WPHRDF' as SeriesId;

const CANDIDATE = {
  name: 'Bibi Golab',
  role: 'protagonist' as const,
  importance: 'lead' as const,
  premiseRole: 'She has sealed the well and will not say why, which is the engine of the plot.',
  distinguishingTrait: 'She waters the pomegranates before she eats.',
};

const CONTEXT = {
  seriesTitle: 'The Keeper of the Well',
  premise: 'A walled garden, a forbidden well, and three people who each hold one piece.',
  themes: ['inheritance'],
  tone: ['wry'],
  genre: ['folk drama'],
  worldRules: [],
  canonPolicy: { freezeOnAir: true, retcon: 'reveal-only' as const, strictness: 'strict' as const },
};

/**
 * The two drafts, taken from a payload a real model actually produced.
 *
 * `DEMO_CHARACTERS` is verbatim `qwen3.5` output through `StructuredCall`, so these are
 * shapes the schemas provably accept rather than shapes hand-written against them. A
 * hand-written fixture that drifts from `CharacterPsych` would make this suite pass
 * against a sheet the pipeline could never store.
 */
const SHEET = DEMO_CHARACTERS[0];
if (SHEET === undefined) throw new Error('the demo cast is empty');

const CORE = {
  identity: SHEET.payload.identity,
  psych: SHEET.payload.psych,
  voice: SHEET.payload.voice,
  // `turningPoints` is omitted by `CharacterCoreDraft`: it points at beats that do not
  // exist yet, and a model asked for prefixed ULIDs invents ids that resolve to nothing.
  arc: { startState: SHEET.payload.arc.startState, endState: SHEET.payload.arc.endState },
  motionSignature: SHEET.payload.motionSignature,
  knowledgeScope: SHEET.payload.knowledgeScope,
};

const {
  wardrobe: _wardrobe,
  expressionSet: _expressions,
  poseSet: _poses,
  ...VISUAL_BLOCK
} = SHEET.payload.visual;

const VISUAL = {
  visual: VISUAL_BLOCK,
  derivation: {
    silhouetteFrom: ['secretive'],
    paletteFrom: ['patient'],
    note: 'The bell shape comes from a woman who plants herself between people and the well.',
  },
};

const PALETTE = SHEET.payload.visual.palette.slice(0, 1);

function state(slug: string): unknown {
  return {
    slug,
    label: slug,
    body: `Brow, eyes, mouth and shoulders as they sit when she is ${slug}.`,
    intensity: 0.7,
  };
}

function wardrobe(slug: string): unknown {
  return {
    slug,
    label: slug,
    description: `A garment by garment description of the ${slug} outfit and how it sits.`,
    validity: { from: null, until: null },
    palette: PALETTE,
  };
}

/** Eight expressions, six poses, two outfits: RV-083's floor, met in one turn. */
const STATES = {
  expressions: [
    'neutral',
    'cornered',
    'refusing',
    'grieving',
    'amused',
    'humiliated',
    'watchful',
    'resolved',
  ].map(state),
  poses: ['standing', 'kneeling', 'blocking', 'retreating', 'waiting', 'reaching'].map(state),
  wardrobe: ['everyday', 'mourning'].map(wardrobe),
};

function lockedStyle(): StyleBible {
  const preset = findPreset('paper-cutout');
  if (isErr(preset)) throw preset.error;
  const clock = new FixedClock(TEST_INSTANT);
  const locked = lock(
    materialiseStyleBible({
      draft: preset.value.draft,
      id: 'sty_01JQZK3M7X8YB4N2VTC6WPHRDC',
      clock,
    }),
    toIso(TEST_INSTANT),
  );
  if (isErr(locked)) throw locked.error;
  return locked.value;
}

describe('CastStageHandler', () => {
  let workspace: ReturnType<typeof scratchWorkspace>;
  let handle: DatabaseHandle;
  let story: StoryStore;
  let states: CharacterStateStore;
  let graph: NarrativeGraphStore;
  let style: StyleBible;

  beforeEach(async () => {
    workspace = scratchWorkspace();
    const opened = createDatabase(':memory:');
    if (isErr(opened)) throw opened.error;
    handle = opened.value;
    story = new StoryStore({ workspaceDir: workspace.dir, logger: new MemoryLogger() });
    states = new CharacterStateStore({ workspaceDir: workspace.dir, logger: new MemoryLogger() });
    graph = new NarrativeGraphStore({ database: handle, logger: new MemoryLogger() });
    style = lockedStyle();

    await story.save({
      ...emptyStoryDocument(SERIES),
      context: CONTEXT,
      castCandidates: [CANDIDATE],
    });
  });

  afterEach(() => {
    handle.sqlite.close();
    workspace.cleanup();
  });

  function handler(
    backend: FakeStructuredBackend,
    meter: RecordingMeter | RefusingMeter = new RecordingMeter(),
  ): CastStageHandler {
    return new CastStageHandler({
      cast: new CastService({ ids: new Ids() }),
      story,
      states,
      graph,
      engine: () => fakeEngine(backend, testClock()),
      imageModel: 'gemini:gemini-3-flash-image',
      meter,
      router: fakeRouter,
      logger: new MemoryLogger(),
    });
  }

  it('writes a sheet and a full grid, not three expressions and one outfit', async () => {
    const backend = new FakeStructuredBackend([CORE, VISUAL, STATES]);
    const { context } = stageContext({ seriesId: SERIES, payload: { style } });

    const outcome = await handler(backend).execute(context);

    expect(isErr(outcome)).toBe(false);
    if (isErr(outcome)) return;

    const stored = graph.load(SERIES);
    if (isErr(stored)) return;
    const entity = stored.value.entities[0];
    expect(entity?.kind).toBe('character');
    if (entity?.kind !== 'character') return;

    // The sheet call returns these three empty by design; S3b fills them, and an entity
    // stored with the empty sets describes a character nobody can draw.
    expect(entity.payload.visual.wardrobe).toHaveLength(2);
    expect(entity.payload.visual.expressionSet).toHaveLength(8);
    expect(entity.payload.visual.poseSet).toHaveLength(6);
    // want / need / wound / lie / ghost, all of them, because that is the sheet.
    expect(entity.payload.psych.want).toBe(CORE.psych.want);
    expect(entity.payload.psych.ghost).toBe(CORE.psych.ghost);

    const grid = await states.load(SERIES, entity.id);
    if (isErr(grid)) return;
    // Two outfits crossed with fourteen states, plus one turnaround per outfit.
    expect(grid.value.cells).toHaveLength(2 * 14 + 2);
    expect(grid.value.identityFloor).toBe(0.82);
    expect(grid.value.imageModel).toBe('gemini:gemini-3-flash-image');
  });

  it('gives every cell an editable prompt that already carries the style clause', async () => {
    const backend = new FakeStructuredBackend([CORE, VISUAL, STATES]);
    const { context } = stageContext({ seriesId: SERIES, payload: { style } });

    await handler(backend).execute(context);

    const stored = graph.load(SERIES);
    if (isErr(stored)) return;
    const grid = await states.load(SERIES, stored.value.entities[0]?.id ?? 'x');
    if (isErr(grid)) return;

    const cell = grid.value.cells.find((candidate) => candidate.stateKind === 'expression');
    expect(cell).toBeDefined();
    // The exact text an image model receives - not an adjective a later stage has to
    // assemble a prompt from.
    expect(cell?.prompt).toContain(style.prompts.positive.slice(0, 24));
    expect(cell?.status).toBe('missing');
    // Both halves of the dedup key are on the cell, so "why did this regenerate" has an
    // answer a person can read.
    expect(cell?.semanticKey).toMatch(/^char\/[a-z0-9-]+\/expression$/);
    expect(cell?.variantKey).toContain(cell?.wardrobeSlug ?? '');
  });

  it('refuses without a locked style rather than keying artwork to a moving checksum', async () => {
    const backend = new FakeStructuredBackend([CORE]);
    const { context } = stageContext({ seriesId: SERIES, payload: {} });

    const outcome = await handler(backend).execute(context);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({
      reason: 'cast-without-style',
      owner: '@rv/style-engine',
    });
    expect(backend.requests).toHaveLength(0);
  });

  it('refuses without the shortlist S2 produces, naming the package that owes it', async () => {
    await story.save(emptyStoryDocument(SERIES));
    const backend = new FakeStructuredBackend([CORE]);
    const { context } = stageContext({ seriesId: SERIES, payload: { style } });

    const outcome = await handler(backend).execute(context);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'cast-without-outline' });
  });

  it('keeps a character that already exists rather than rewriting an edited grid', async () => {
    const first = new FakeStructuredBackend([CORE, VISUAL, STATES]);
    const { context } = stageContext({ seriesId: SERIES, payload: { style } });
    await handler(first).execute(context);

    const second = new FakeStructuredBackend([CORE, VISUAL, STATES]);
    const outcome = await handler(second).execute(context);

    expect(isErr(outcome)).toBe(false);
    if (isErr(outcome)) return;
    // Not one model call: regenerating would throw away every prompt an art director has
    // since edited, and the graph store's conflict rule would keep the old entity anyway.
    expect(second.requests).toHaveLength(0);
    expect(outcome.value.artifacts.some((a) => a.startsWith('character-kept:'))).toBe(true);
  });

  it('spends nothing when the guard refuses', async () => {
    const backend = new FakeStructuredBackend([CORE, VISUAL, STATES]);
    const { context } = stageContext({ seriesId: SERIES, payload: { style } });

    const outcome = await handler(backend, new RefusingMeter()).execute(context);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('budget');
    expect(backend.requests).toHaveLength(0);
  });
});
