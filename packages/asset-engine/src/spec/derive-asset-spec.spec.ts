import { describe, expect, it } from 'vitest';
import { AssetSpec } from '@rv/contracts';
import { isErr, unwrap } from '@rv/shared-kernel';

import {
  characterEntity,
  creatureEntity,
  HASH_B,
  locationEntity,
  propEntity,
  vehicleEntity,
} from '../__fixtures__/builders';
import { templateFor } from '../rig/templates/index';
import { CANVAS_BY_QUALITY, archetypeFromPayload } from './archetype-map';
import { DeriveAssetSpecUseCase, identityAnchors, styleAnchors } from './derive-asset-spec';

const derive = new DeriveAssetSpecUseCase();

describe('DeriveAssetSpecUseCase', () => {
  it('turns a character entity into a schema-valid biped spec', () => {
    const spec = unwrap(derive.execute({ source: { kind: 'entity', entity: characterEntity() } }));

    expect(AssetSpec.safeParse(spec).success).toBe(true);
    expect(spec.archetype).toBe('biped');
    expect(spec.subjectClass).toBe('character');
    expect(spec.semanticKey).toBe('char/kael-vandermeer');
  });

  it('derives the part plan from the archetype template, so the parts bind by name', () => {
    const spec = unwrap(derive.execute({ source: { kind: 'entity', entity: characterEntity() } }));
    const roles = new Set(templateFor('biped').bones.map((bone) => bone.role));

    expect(spec.parts.length).toBeGreaterThan(5);
    for (const part of spec.parts) expect(roles.has(part.role)).toBe(true);
  });

  it('reads riggability off the prop payload rather than defaulting', () => {
    const rigged = unwrap(derive.execute({ source: { kind: 'entity', entity: propEntity(true) } }));
    const flat = unwrap(derive.execute({ source: { kind: 'entity', entity: propEntity(false) } }));

    expect(rigged.archetype).toBe('articulated-prop');
    expect(flat.archetype).toBe('rigid-prop');
    expect(archetypeFromPayload(characterEntity())).toBeUndefined();
  });

  it('honours an explicit archetype override, because S3 knows things this package cannot', () => {
    const spec = unwrap(
      derive.execute({
        source: { kind: 'entity', entity: characterEntity() },
        archetype: 'winged',
      }),
    );
    expect(spec.archetype).toBe('winged');
    expect(spec.parts.some((part) => part.role === 'wing-left')).toBe(true);
  });

  it('turns each named visual state into a variant, keyed by its kind', () => {
    const spec = unwrap(derive.execute({ source: { kind: 'entity', entity: characterEntity() } }));
    const keys = spec.variants.map((variant) => variant.key);

    expect(keys).toContain('expression-cornered');
    expect(keys).toContain('pose-reaching');
    expect(keys).toContain('wardrobe-winter');
  });

  it.each([
    ['creature', creatureEntity, 'state-wary', 'quadruped'],
    ['prop', () => propEntity(false), 'condition-bent', 'rigid-prop'],
    ['vehicle', vehicleEntity, 'condition-laden', 'wheeled'],
  ] as const)('extracts %s variants from its own payload list', (_kind, build, key, archetype) => {
    const spec = unwrap(derive.execute({ source: { kind: 'entity', entity: build() } }));
    expect(spec.archetype).toBe(archetype);
    expect(spec.variants.map((variant) => variant.key)).toContain(key);
  });

  it('multiplies a location by its lighting, weather and mood states', () => {
    const spec = unwrap(derive.execute({ source: { kind: 'entity', entity: locationEntity() } }));
    const keys = spec.variants.map((variant) => variant.key);

    // This is the "fourteen backgrounds" multiplication the world model exists to make
    // countable rather than guessed.
    expect(keys).toEqual(
      expect.arrayContaining(['light-dusk', 'light-night', 'weather-rain', 'mood-after']),
    );
    expect(spec.archetype).toBe('backdrop');
    expect(spec.requireAlpha).toBe(false);
  });

  it('gives an entity kind with no variant list an empty one rather than throwing', () => {
    const entity = characterEntity();
    const faction = { ...entity, kind: 'faction' as const };
    // Only the extractor table is under test here; the payload stays a character's, and
    // the table's job is to answer "none" for a kind that contributes no variants.
    const spec = unwrap(
      derive.execute({
        source: {
          kind: 'entity',
          entity: { ...faction, payload: entity.payload } as typeof entity,
        },
      }),
    );
    expect(spec.variants).toHaveLength(0);
    expect(spec.archetype).toBe('ui-element');
  });

  it('leaves the remaining kinds with no variants, rather than omitting them from the table', () => {
    const entity = characterEntity();
    for (const kind of ['concept', 'event', 'substance'] as const) {
      const spec = unwrap(
        derive.execute({
          source: {
            kind: 'entity',
            entity: { ...entity, kind, payload: entity.payload } as typeof entity,
          },
        }),
      );
      expect(spec.variants).toHaveLength(0);
    }
  });

  it('sizes the canvas from the measured resolution ladder', () => {
    const draft = unwrap(
      derive.execute({ source: { kind: 'entity', entity: characterEntity() }, quality: 'draft' }),
    );
    const final = unwrap(
      derive.execute({ source: { kind: 'entity', entity: characterEntity() }, quality: 'final' }),
    );

    expect(draft.canvas).toEqual(CANVAS_BY_QUALITY.draft);
    expect(final.canvas).toEqual(CANVAS_BY_QUALITY.final);
  });

  it('builds a spec from a bare scene requirement', () => {
    const spec = unwrap(
      derive.execute({
        source: {
          kind: 'requirement',
          requirement: {
            semanticKey: 'ground/cobbles/wet',
            label: 'Wet cobbles',
            description: 'A patch of rain-slick cobblestones.',
            archetype: 'backdrop',
            subjectClass: 'ground',
            tags: ['street', 'Not A Slug'],
          },
        },
      }),
    );

    expect(spec.archetype).toBe('backdrop');
    // A backdrop is the one thing that legitimately fills its frame.
    expect(spec.requireAlpha).toBe(false);
    expect(spec.tags).toEqual(['street']);
  });

  it('accepts canvas, height and extra variant overrides', () => {
    const spec = unwrap(
      derive.execute({
        source: { kind: 'entity', entity: propEntity(false) },
        canvas: { width: 640, height: 480 },
        nominalHeight: 111,
        extraVariants: [
          {
            key: 'night-lit',
            label: 'Night',
            instruction: 'Light it from a lantern',
            affectedParts: [],
          },
        ],
        references: styleAnchors([HASH_B]),
      }),
    );

    expect(spec.canvas).toEqual({ width: 640, height: 480 });
    expect(spec.nominalHeight).toBe(111);
    expect(spec.variants.map((variant) => variant.key)).toContain('night-lit');
    expect(spec.references[0]?.role).toBe('style-anchor');
  });

  it('reports a validation failure instead of returning a half-built spec', () => {
    const entity = characterEntity({ canonicalName: '!!!' });
    // A name that slugifies to nothing produces an illegal semantic key, and the spec
    // must not leave the use-case in that state.
    expect(isErr(derive.execute({ source: { kind: 'entity', entity } }))).toBe(true);
  });

  it('marks identity anchors distinctly from style anchors', () => {
    expect(identityAnchors([HASH_B])[0]?.role).toBe('identity-anchor');
    expect(styleAnchors([HASH_B], 0.5)[0]?.weight).toBe(0.5);
  });
});
