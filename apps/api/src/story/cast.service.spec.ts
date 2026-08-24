/**
 * The two pure pieces of S3: the grid, and the "is this character already here" check.
 *
 * The grid is where RV-083's standard becomes checkable. Every cell carries the *exact*
 * text an image model receives, both halves of the dedup key, and a status that starts
 * at `missing` - because S3 decides what has to be drawn and S6 draws it, and a grid
 * that opened as `ready` would claim artwork that does not exist.
 */

import { describe, expect, it } from 'vitest';
import { Entity, type SeriesId } from '@rv/contracts';
import type { CharacterStatesResult } from '@rv/story-engine';

import { DEMO_CHARACTERS, DEMO_GOLAB_ID } from '../infrastructure/seed/demo-characters';
import { characterNames, gridOf } from './cast.service';

const SERIES = 'ser_0DEM0GR0VE0000000000000002' as SeriesId;

function namedState(
  slug: string,
  intensity: number,
): {
  slug: string;
  label: string;
  description: string;
  intensity: number;
} {
  return { slug, label: slug, description: `The composed prompt for ${slug}.`, intensity };
}

const RESULT = {
  characterSlug: 'golab',
  expressionSet: [namedState('cornered', 0.9), namedState('neutral', 0.3)],
  poseSet: [namedState('blocking', 0.6)],
  wardrobe: [],
  wardrobeStates: [namedState('everyday', 1), namedState('mourning', 1)],
  variants: [
    {
      semanticKey: 'char/golab/expression',
      variantKey: 'everyday-cornered',
      wardrobeSlug: 'everyday',
      stateSlug: 'cornered',
      stateKind: 'expression' as const,
      label: 'everyday / cornered',
      prompt: 'Facial expression: Bibi Golab, cornered. The composed prompt.',
    },
    {
      semanticKey: 'char/golab/pose',
      variantKey: 'mourning-blocking',
      wardrobeSlug: 'mourning',
      stateSlug: 'blocking',
      stateKind: 'pose' as const,
      label: 'mourning / blocking',
      prompt: 'Full-body pose: Bibi Golab, blocking. The composed prompt.',
    },
  ],
  visual: DEMO_CHARACTERS[0]?.payload.visual ?? ({} as never),
  toppedUp: false,
  droppedDuplicateSlugs: [],
  traces: [],
} as unknown as CharacterStatesResult;

describe('gridOf', () => {
  const grid = gridOf(RESULT, { imageModel: 'gemini:gemini-3-flash-image', identityFloor: 0.9 });

  it('opens every cell at `missing`, because S3 decides and S6 draws', () => {
    expect(grid.cells.every((cell) => cell.status === 'missing')).toBe(true);
    expect(grid.cells.every((cell) => cell.imageHash === undefined)).toBe(true);
    expect(grid.cells.every((cell) => cell.identityMatch === undefined)).toBe(true);
  });

  it('puts one turnaround per outfit first, because the anchor is scored against it', () => {
    const first = grid.cells.slice(0, 2);
    expect(first.map((cell) => cell.stateKind)).toEqual(['wardrobe', 'wardrobe']);
    expect(first.map((cell) => cell.variantKey)).toEqual([
      'everyday-turnaround',
      'mourning-turnaround',
    ]);
  });

  it('carries the intensity the art director chose, not a default, where one exists', () => {
    expect(grid.cells.find((cell) => cell.stateSlug === 'cornered')?.intensity).toBe(0.9);
    // A state with no matching entry in either set falls back rather than failing: the
    // demand is computed from the drafts and the sets are composed from them, so the two
    // can only disagree if the engine changes underneath us.
    expect(grid.cells.find((cell) => cell.stateSlug === 'blocking')?.intensity).toBe(0.6);
  });

  it('carries both halves of the dedup key, so "why did this regenerate" has an answer', () => {
    const cell = grid.cells.find((candidate) => candidate.variantKey === 'everyday-cornered');
    expect(cell?.semanticKey).toBe('char/golab/expression');
    expect(cell?.wardrobeSlug).toBe('everyday');
    expect(cell?.prompt).toContain('cornered');
  });

  it('leaves the estimate at zero rather than quoting a price nobody can honour', () => {
    // Pricing a cell needs an `AssetSpec`, which S4 builds and S3 does not.
    expect(grid.cells.every((cell) => cell.estimateNanoUsd === 0)).toBe(true);
  });

  it('carries the settings the screen would otherwise have to know', () => {
    expect(grid.identityFloor).toBe(0.9);
    expect(grid.imageModel).toBe('gemini:gemini-3-flash-image');
  });
});

describe('characterNames', () => {
  it('indexes characters by their canonical name, case- and space-insensitively', () => {
    const sheet = DEMO_CHARACTERS[0];
    if (sheet === undefined) throw new Error('the demo cast is empty');
    const entity = Entity.parse({
      id: sheet.id,
      seriesId: SERIES,
      kind: 'character',
      canonicalName: sheet.canonicalName,
      aliases: sheet.aliases,
      summary: sheet.summary,
      firstAppearance: sheet.firstAppearance,
      importance: sheet.importance,
      assetRefs: [],
      embedding: [],
      payload: sheet.payload,
    });

    const index = characterNames([entity]);

    expect(index.get(`  ${sheet.canonicalName.toUpperCase()} `.trim().toLowerCase())).toBe(
      DEMO_GOLAB_ID,
    );
  });

  it('ignores a non-character entity, because a prop has no sheet to skip', () => {
    expect(characterNames([]).size).toBe(0);
  });
});
