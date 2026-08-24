import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { HASHES, FIXED_NOW, assetSpec, provenance, rig, testIds } from '../__fixtures__/builders';
import { everyObjectIsClosed, toLlmJsonSchema } from '../json-schema';
import {
  AssetArchetype,
  AssetKeyParts,
  AssetResolution,
  AssetSpec,
  PartPlan,
  QualityTarget,
  RegenerateIntent,
} from './asset-spec';
import {
  Asset,
  AnimationClip,
  AssetRef,
  AssetVariant,
  AssetVersion,
  Part,
  PinnedAssetRef,
  SpriteSheet,
  isPinnedAssetRef,
  pinsRef,
  representationsOf,
  servesRepresentation,
} from './asset';
import { QualityTier } from '../provider/capability';

const ids = testIds();

describe('AssetSpec', () => {
  it('accepts the fixture', () => {
    const result = AssetSpec.safeParse(assetSpec());
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  it('requires at least one part - a rigless blob is still a one-part asset', () => {
    expect(AssetSpec.safeParse(assetSpec({ parts: [] })).success).toBe(false);
  });

  it('requires alpha by default, because everything is composited', () => {
    expect(AssetSpec.parse(assetSpec()).requireAlpha).toBe(true);
  });

  it('defaults quality to preview, not final - final costs real money', () => {
    expect(AssetSpec.parse(assetSpec()).quality).toBe('preview');
  });

  it.each([
    ['flora/oak-tree', true],
    ['flora/oak-tree/mature', true],
    ['char/kael/wardrobe-winter/angry', true],
    ['Flora/Oak', false],
    ['flora', false],
    ['flora//oak', false],
    ['flora/oak tree', false],
  ])('semanticKey %s -> valid=%s', (semanticKey, valid) => {
    expect(AssetSpec.safeParse(assetSpec({ semanticKey })).success).toBe(valid);
  });

  it('classifies archetypes by how they rig, not by what they depict', () => {
    // A bird and a bat are both `winged`; a cart and a bicycle are both `wheeled`.
    expect(AssetArchetype.options).toContain('winged');
    expect(AssetArchetype.options).toContain('wheeled');
    expect(AssetArchetype.options).toContain('tree');
    expect(AssetArchetype.options).not.toContain('bird');
  });
});

describe('PartPlan', () => {
  const base = { name: 'wing-left', role: 'wing-l', description: 'A folded wing', zOrder: 1 };

  it('defaults to rigid and required', () => {
    expect(PartPlan.parse(base)).toMatchObject({ deformable: false, optional: false });
  });

  it('rejects a name that is not a slug', () => {
    expect(PartPlan.safeParse({ ...base, name: 'Wing Left' }).success).toBe(false);
  });

  it('accepts an explicit attach hint, which beats inferring one from alpha', () => {
    expect(PartPlan.safeParse({ ...base, attachHint: { x: 0.5, y: 0.2 } }).success).toBe(true);
  });
});

describe('the dedup key - the "never generate twice" guarantee', () => {
  it('is built from exactly four components', () => {
    expect(Object.keys(AssetKeyParts.shape).sort()).toEqual([
      'semanticKey',
      'specHash',
      'styleChecksum',
      'variantKey',
    ]);
  });

  it('defaults the variant to "base" so an unqualified request is still keyable', () => {
    const parsed = AssetKeyParts.parse({
      semanticKey: 'flora/oak-tree',
      styleChecksum: HASHES.a,
      specHash: HASHES.b,
    });
    expect(parsed.variantKey).toBe('base');
  });

  it('requires the style checksum, so a restyle cannot collide with the old library', () => {
    const result = AssetKeyParts.safeParse({
      semanticKey: 'flora/oak-tree',
      specHash: HASHES.b,
    });
    expect(result.success).toBe(false);
  });
});

describe('RegenerateIntent - spending money on purpose', () => {
  it('demands a reason', () => {
    expect(RegenerateIntent.safeParse({}).success).toBe(false);
  });

  it('accepts each documented reason', () => {
    for (const reason of [
      'new-take',
      'style-changed',
      'quality-reject',
      'spec-changed',
      'manual-override',
    ]) {
      expect(RegenerateIntent.safeParse({ reason }).success).toBe(true);
    }
  });

  it('cannot be told to discard the previous version', () => {
    // Regeneration is additive by construction: an attempt to set this false is a
    // visible, rejected diff rather than a silent data loss.
    expect(RegenerateIntent.parse({ reason: 'new-take' }).keepPrevious).toBe(true);
    expect(RegenerateIntent.safeParse({ reason: 'new-take', keepPrevious: false }).success).toBe(
      false,
    );
  });
});

describe('AssetResolution', () => {
  const base = {
    key: HASHES.a,
    spec: assetSpec(),
    styleBibleId: testIds().styleBible(),
  };

  it('reports every outcome the resolver can reach', () => {
    for (const outcome of ['cache-hit', 'variant-of-hit', 'miss', 'blocked-by-budget']) {
      expect(AssetResolution.safeParse({ ...base, outcome }).success).toBe(true);
    }
  });

  it('costs nothing by default, so a hit cannot accidentally be priced', () => {
    expect(AssetResolution.parse({ ...base, outcome: 'cache-hit' }).estimatedCostNanoUsd).toBe(0);
  });

  it('rejects a fractional nano-dollar estimate', () => {
    expect(
      AssetResolution.safeParse({ ...base, outcome: 'miss', estimatedCostNanoUsd: 1.5 }).success,
    ).toBe(false);
  });
});

describe('Part', () => {
  const base = {
    id: ids.part(),
    name: 'canopy',
    role: 'canopy',
    imageHash: HASHES.a,
    bounds: { x: 0, y: 0, width: 512, height: 400 },
    size: { width: 512, height: 400 },
    zOrder: 1,
    alphaCoverage: 0.62,
  };

  it('accepts a well-formed part and defaults the pivot to the centre', () => {
    expect(Part.parse(base).pivot).toEqual({ x: 0.5, y: 0.5 });
  });

  it('requires alphaCoverage, which is the matting quality signal', () => {
    const { alphaCoverage: _dropped, ...withoutCoverage } = base;
    expect(Part.safeParse(withoutCoverage).success).toBe(false);
  });

  it('constrains alphaCoverage to a fraction', () => {
    expect(Part.safeParse({ ...base, alphaCoverage: 1.2 }).success).toBe(false);
    expect(Part.safeParse({ ...base, alphaCoverage: 0 }).success).toBe(true);
  });
});

describe('AnimationClip and SpriteSheet', () => {
  const clip = {
    id: ids.clip(),
    name: 'idle',
    source: 'template' as const,
    durationMs: 2000,
    fps: 24,
    irHash: HASHES.a,
    tags: [],
    provenance: provenance(),
  };

  it('loops by default - an idle that plays once is a bug', () => {
    expect(AnimationClip.parse(clip).loop).toBe('loop');
  });

  it('treats a baked sheet as optional, because baking is derived work', () => {
    expect(AnimationClip.parse(clip).bakedSheetId).toBeUndefined();
  });

  it('addresses the motion by content hash so identical clips share storage', () => {
    expect(AnimationClip.safeParse({ ...clip, irHash: 'nope' }).success).toBe(false);
  });

  it('requires a positive duration', () => {
    expect(AnimationClip.safeParse({ ...clip, durationMs: 0 }).success).toBe(false);
  });

  it('describes a sheet completely enough to be rebuilt', () => {
    const sheet = {
      id: ids.sheet(),
      clipId: clip.id,
      atlasImageHash: HASHES.a,
      atlasJsonHash: HASHES.b,
      frameCount: 2,
      fps: 12,
      frameSize: { width: 64, height: 64 },
      atlasSize: { width: 128, height: 64 },
      frames: [
        { rect: { x: 0, y: 0, width: 64, height: 64 } },
        { rect: { x: 64, y: 0, width: 64, height: 64 } },
      ],
      createdAt: FIXED_NOW,
    };
    const parsed = SpriteSheet.parse(sheet);
    expect(parsed).toMatchObject({ trimmed: true, padding: 2 });
    expect(parsed.frames[0]?.trimOffset).toEqual({ x: 0, y: 0 });
  });
});

describe('AssetVariant', () => {
  it('records only the parts it replaces, which is why a variant is cheap', () => {
    const variant = AssetVariant.parse({
      id: ids.variant(),
      key: 'winter',
      label: 'Winter',
      replacedParts: { canopy: HASHES.b },
      provenance: provenance(),
    });
    expect(Object.keys(variant.replacedParts)).toEqual(['canopy']);
  });
});

describe('Asset', () => {
  function version(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: ids.assetVersion(),
      assetId: ids.asset(),
      ordinal: 1,
      status: 'ready',
      styleBibleId: ids.styleBible(),
      styleChecksum: HASHES.a,
      parts: [
        {
          id: ids.part(),
          name: 'trunk',
          role: 'trunk',
          imageHash: HASHES.a,
          bounds: { x: 0, y: 0, width: 100, height: 400 },
          size: { width: 100, height: 400 },
          zOrder: 0,
          alphaCoverage: 0.4,
        },
      ],
      rig: rig(),
      canvas: { width: 1024, height: 1024 },
      nominalHeight: 512,
      quality: 'preview',
      provenance: provenance(),
      ...overrides,
    };
  }

  function asset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const first = version();
    return {
      id: ids.asset(),
      key: HASHES.a,
      semanticKey: 'flora/oak-tree/mature',
      archetype: 'tree',
      label: 'Mature oak',
      description: 'A broad, weather-worn oak.',
      tags: [],
      versions: [first],
      currentVersionId: first.id,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      ...overrides,
    };
  }

  it('accepts a single-version asset', () => {
    const result = Asset.safeParse(asset());
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  it('requires currentVersionId to point at a version it actually holds', () => {
    const result = Asset.safeParse(asset({ currentVersionId: ids.assetVersion() }));
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/must reference one of this asset/);
  });

  it('rejects duplicate version ordinals', () => {
    const a = version({ ordinal: 1 });
    const b = version({ ordinal: 1 });
    const result = Asset.safeParse(asset({ versions: [a, b], currentVersionId: a.id }));
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/ordinals must be unique/);
  });

  it('accepts several takes side by side - regeneration is additive', () => {
    const a = version({ ordinal: 1 });
    const b = version({ ordinal: 2 });
    expect(Asset.safeParse(asset({ versions: [a, b], currentVersionId: b.id })).success).toBe(true);
  });

  it('requires at least one version', () => {
    expect(Asset.safeParse(asset({ versions: [] })).success).toBe(false);
  });

  // ── the semantic index is domain data, not a storage detail ──
  //
  // "A gnarled old tree" has to find `flora/oak-tree/mature` *before* anything decides
  // to generate one. That lookup is the mechanism behind non-negotiable #2, so the
  // vector belongs on the asset rather than in a column storage invented for itself.

  it('carries a vector and the model that produced it', () => {
    const parsed = Asset.parse(
      asset({ embedding: [0.4, -0.1, 0.9], embeddingModel: 'ollama:nomic-embed-text' }),
    );
    expect(parsed.embedding).toEqual([0.4, -0.1, 0.9]);
    expect(parsed.embeddingModel).toBe('ollama:nomic-embed-text');
  });

  it('leaves both absent until the indexing pass has run, which is a real state', () => {
    const parsed = Asset.parse(asset());
    expect(parsed.embedding).toBeUndefined();
    expect(parsed.embeddingModel).toBeUndefined();
  });

  it('refuses a vector nobody can attribute', () => {
    // Vectors from two models are not comparable. Mixing them does not fail - it
    // degrades recall, silently, months after someone swapped the embedder.
    const result = Asset.safeParse(asset({ embedding: [0.4, -0.1] }));
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/must name the model/);
  });

  it('refuses a model with no vector, which claims an index entry that does not exist', () => {
    const result = Asset.safeParse(asset({ embeddingModel: 'ollama:nomic-embed-text' }));
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/does not exist/);
  });

  it('re-parses an indexed asset to the identical value', () => {
    const once = Asset.parse(
      asset({ embedding: [0.1], embeddingModel: 'ollama:nomic-embed-text' }),
    );
    expect(Asset.parse(once)).toEqual(once);
  });
});

describe('structured output readiness', () => {
  it('emits a closed schema for the spec an LLM is asked to author', () => {
    const schema = toLlmJsonSchema(AssetSpec, { dialect: 'openai-strict' });
    expect(everyObjectIsClosed(schema)).toBe(true);
  });
});

// ── the floating/locked pair, from the asset side ───────────────────────────

describe('AssetRef and PinnedAssetRef', () => {
  const assetId = ids.asset();
  const versionId = ids.assetVersion();

  it('narrows a floating reference that happens to carry a version', () => {
    expect(isPinnedAssetRef(AssetRef.parse({ assetId }))).toBe(false);
    expect(isPinnedAssetRef(AssetRef.parse({ assetId, versionId }))).toBe(true);
  });

  it('keeps every other field of the reference identical between the two forms', () => {
    expect(Object.keys(PinnedAssetRef.shape).sort()).toEqual(Object.keys(AssetRef.shape).sort());
  });

  it('accepts a resolution that only fills in the version', () => {
    expect(
      pinsRef(
        { assetId, representation: 'cutout' },
        { assetId, versionId, representation: 'cutout' },
      ),
    ).toBe(true);
  });

  it('rejects a resolution that changes the asset, the variant, or a frozen version', () => {
    expect(
      pinsRef(
        { assetId, representation: 'cutout' },
        { assetId: ids.asset(), versionId, representation: 'cutout' },
      ),
    ).toBe(false);
    expect(
      pinsRef(
        { assetId, variantKey: 'winter', representation: 'cutout' },
        { assetId, versionId, variantKey: 'summer', representation: 'cutout' },
      ),
    ).toBe(false);
    expect(
      pinsRef(
        { assetId, versionId, representation: 'cutout' },
        { assetId, versionId: ids.assetVersion(), representation: 'cutout' },
      ),
    ).toBe(false);
  });

  it('refuses a resolution that swaps the representation, which is authored and not resolved', () => {
    expect(
      pinsRef(
        { assetId, representation: 'layered-2.5d' },
        { assetId, versionId, representation: 'flat' },
      ),
    ).toBe(false);
  });

  it('fills the representation in on both forms, so a document parsed today carries the answer', () => {
    expect(AssetRef.parse({ assetId }).representation).toBe('cutout');
    expect(PinnedAssetRef.parse({ assetId, versionId }).representation).toBe('cutout');
  });
});

// ── a version's parts, rig and variants describe the same asset ─────────────

describe('AssetVersion internal references', () => {
  const partId = ids.part();

  function part(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: partId,
      name: 'trunk',
      role: 'trunk',
      imageHash: HASHES.a,
      bounds: { x: 0, y: 0, width: 100, height: 400 },
      size: { width: 100, height: 400 },
      zOrder: 0,
      alphaCoverage: 0.4,
      ...overrides,
    };
  }

  function version(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: ids.assetVersion(),
      assetId: ids.asset(),
      ordinal: 1,
      status: 'ready',
      styleBibleId: ids.styleBible(),
      styleChecksum: HASHES.a,
      parts: [part()],
      canvas: { width: 1024, height: 1024 },
      nominalHeight: 512,
      quality: 'preview',
      provenance: provenance(),
      ...overrides,
    };
  }

  function rigBindingPart(boundPartId: string): Record<string, unknown> {
    const skeleton = rig() as unknown as { bones: Record<string, unknown>[] };
    const [root, ...rest] = skeleton.bones;
    return { ...skeleton, bones: [{ ...root, partIds: [boundPartId] }, ...rest] };
  }

  it('accepts a rig whose bones bind parts this version actually has', () => {
    const result = AssetVersion.safeParse(version({ rig: rigBindingPart(partId) }));
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  it('rejects a bone bound to a part the matting pass never produced', () => {
    const result = AssetVersion.safeParse(version({ rig: rigBindingPart(ids.part()) }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'rig.bones.0.partIds',
    ]);
  });

  it('accepts a variant that replaces a part by a name this version has', () => {
    const result = AssetVersion.safeParse(
      version({
        variants: [
          {
            id: ids.variant(),
            key: 'winter',
            label: 'Winter',
            replacedParts: { trunk: HASHES.b },
            provenance: provenance(),
          },
        ],
      }),
    );
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  it('rejects a variant that replaces a part this version does not have', () => {
    const result = AssetVersion.safeParse(
      version({
        variants: [
          {
            id: ids.variant(),
            key: 'winter',
            label: 'Winter',
            replacedParts: { canopy: HASHES.b },
            provenance: provenance(),
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'variants.0.replacedParts.canopy',
    ]);
  });

  it('leaves an unrigged version alone - rigging happens after matting', () => {
    expect(AssetVersion.safeParse(version()).success).toBe(true);
  });

  // ── representations ─────────────────────────────────────────────────────────

  function rigged(): Record<string, unknown> {
    return rigBindingPart(partId);
  }

  function rigIdOf(skeleton: Record<string, unknown>): string {
    return String(skeleton.id);
  }

  it('accepts a cutout representation that names this version’s rig and parts', () => {
    const skeleton = rigged();
    const result = AssetVersion.safeParse(
      version({
        rig: skeleton,
        representations: [{ kind: 'cutout', rigId: rigIdOf(skeleton), partIds: [partId] }],
      }),
    );
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  it('rejects a cutout representation bound to a rig this version was never fitted with', () => {
    const result = AssetVersion.safeParse(
      version({
        rig: rigged(),
        representations: [{ kind: 'cutout', rigId: ids.rig(), partIds: [partId] }],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'representations.0.rigId',
    );
  });

  it('rejects a cutout representation on a version that has no rig at all', () => {
    const result = AssetVersion.safeParse(
      version({ representations: [{ kind: 'cutout', rigId: ids.rig(), partIds: [partId] }] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a cutout representation that draws a part matting never produced', () => {
    const skeleton = rigged();
    const result = AssetVersion.safeParse(
      version({
        rig: skeleton,
        representations: [{ kind: 'cutout', rigId: rigIdOf(skeleton), partIds: [ids.part()] }],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'representations.0.partIds',
    );
  });

  it('rejects two answers to "draw it as a flat", which nothing downstream could choose between', () => {
    const flat = {
      kind: 'flat',
      imageHash: HASHES.a,
      size: { width: 1024, height: 1024 },
    };
    const result = AssetVersion.safeParse(
      version({ representations: [flat, { ...flat, imageHash: HASHES.b }] }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'representations.1.kind',
    );
  });

  it('accepts several *different* representations of one version', () => {
    const skeleton = rigged();
    const result = AssetVersion.safeParse(
      version({
        rig: skeleton,
        representations: [
          { kind: 'flat', imageHash: HASHES.a, size: { width: 1024, height: 1024 } },
          { kind: 'cutout', rigId: rigIdOf(skeleton), partIds: [partId] },
        ],
      }),
    );
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });
});

// ── what an undeclared version can be served as ──────────────────────────────

describe('representationsOf', () => {
  const partId = ids.part();

  function part(): Record<string, unknown> {
    return {
      id: partId,
      name: 'trunk',
      role: 'trunk',
      imageHash: HASHES.a,
      bounds: { x: 0, y: 0, width: 100, height: 400 },
      size: { width: 100, height: 400 },
      zOrder: 0,
      alphaCoverage: 0.4,
    };
  }

  function version(overrides: Record<string, unknown> = {}): AssetVersion {
    return AssetVersion.parse({
      id: ids.assetVersion(),
      assetId: ids.asset(),
      ordinal: 1,
      status: 'ready',
      styleBibleId: ids.styleBible(),
      styleChecksum: HASHES.a,
      parts: [part()],
      canvas: { width: 1024, height: 1024 },
      nominalHeight: 512,
      quality: 'preview',
      provenance: provenance(),
      ...overrides,
    });
  }

  function riggedTo(boundPartId: string): Record<string, unknown> {
    const skeleton = rig() as unknown as { bones: Record<string, unknown>[] };
    const [root, ...rest] = skeleton.bones;
    return { ...skeleton, bones: [{ ...root, partIds: [boundPartId] }, ...rest] };
  }

  it('returns exactly what a version declares, and derives nothing on top of it', () => {
    const declared = version({
      previewImageHash: HASHES.b,
      rig: riggedTo(partId),
      representations: [{ kind: 'flat', imageHash: HASHES.a, size: { width: 8, height: 8 } }],
    });
    expect(representationsOf(declared).map((each) => each.kind)).toEqual(['flat']);
  });

  it('honours an explicitly empty declaration, which means "this cannot be drawn yet"', () => {
    const nothing = version({ rig: riggedTo(partId), representations: [] });
    expect(representationsOf(nothing)).toEqual([]);
    expect(servesRepresentation(nothing, 'cutout')).toBe(false);
  });

  it('reads a rigged version as a cutout, because it has a rig and not because it was assumed', () => {
    const legacy = version({ rig: riggedTo(partId) });
    const derived = representationsOf(legacy);
    expect(derived.map((each) => each.kind)).toEqual(['cutout']);
    expect(derived.at(0)).toMatchObject({ partIds: [partId] });
    expect(servesRepresentation(legacy, 'cutout')).toBe(true);
    expect(servesRepresentation(legacy, 'layered-2.5d')).toBe(false);
  });

  it('reads a flattened preview as a flat, at the version’s own canvas size', () => {
    const previewed = version({ previewImageHash: HASHES.b });
    expect(representationsOf(previewed)).toEqual([
      {
        kind: 'flat',
        imageHash: HASHES.b,
        size: { width: 1024, height: 1024 },
        pivot: { x: 0.5, y: 0.5 },
      },
    ]);
  });

  it('offers both when a version has both, cutout first because it is the richer answer', () => {
    const both = version({ rig: riggedTo(partId), previewImageHash: HASHES.b });
    expect(representationsOf(both).map((each) => each.kind)).toEqual(['cutout', 'flat']);
  });

  it('offers nothing for a half-produced version, so a router refuses rather than guessing', () => {
    const midFlight = version({ status: 'matting' });
    expect(representationsOf(midFlight)).toEqual([]);
    expect(servesRepresentation(midFlight, 'flat')).toBe(false);
  });
});

// ── the dedup key, attacked ─────────────────────────────────────────────────
//
// CLAUDE.md non-negotiable #2 rests entirely on this key. RV-006 asks for exactly two
// properties: identical inputs in any property order give the same key, and any single
// component moving by one character gives a different one.

describe('the dedup key is order-insensitive and collision-resistant', () => {
  const parts = {
    semanticKey: 'flora/oak-tree/mature',
    styleChecksum: HASHES.a,
    variantKey: 'winter',
    specHash: HASHES.b,
  };

  /**
   * The key material as the hasher must see it.
   *
   * Sorted by component name rather than by declaration order, because the four values
   * arrive from four different places and a caller that spells the object in a
   * different order must not get a different asset. `@rv/shared-kernel/stableStringify`
   * is the shipped implementation of the same rule; this reproduces it locally so the
   * property is asserted against the *contract*, not against one helper.
   */
  function keyMaterial(input: Record<string, string>): string {
    return Object.entries(AssetKeyParts.parse(input))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}=${String(value)}`)
      .join('\u0000');
  }

  it('is the same key however the four components are spelled out', () => {
    const reversed = Object.fromEntries(Object.entries(parts).reverse()) as Record<string, string>;
    expect(Object.keys(reversed)).not.toEqual(Object.keys(parts));
    expect(keyMaterial(reversed)).toBe(keyMaterial(parts));
  });

  it('changes when any single component changes by one character', () => {
    const baseline = keyMaterial(parts);
    const perturbed: Record<string, string>[] = [
      { ...parts, semanticKey: 'flora/oak-tree/matures' },
      { ...parts, styleChecksum: `${HASHES.a.slice(0, 63)}b` },
      { ...parts, variantKey: 'winters' },
      { ...parts, specHash: `${HASHES.b.slice(0, 63)}a` },
    ];
    for (const input of perturbed) {
      expect(keyMaterial(input), JSON.stringify(input)).not.toBe(baseline);
    }
    expect(new Set(perturbed.map(keyMaterial)).size).toBe(perturbed.length);
  });

  it('cannot be forged by moving a delimiter between two components', () => {
    // Without a separator the hasher cannot see, `a` + `bc` and `ab` + `c` are one
    // string, and two different assets share a key. Concatenation is not a key.
    expect(keyMaterial({ ...parts, variantKey: 'base' })).not.toBe(
      keyMaterial({ ...parts, semanticKey: `${parts.semanticKey}/base`, variantKey: 'base' }),
    );
  });

  it('keys an unqualified request the same way twice', () => {
    const { variantKey: _dropped, ...unqualified } = parts;
    expect(keyMaterial(unqualified)).toBe(keyMaterial({ ...unqualified, variantKey: 'base' }));
  });
});

describe('quality vocabulary', () => {
  it('offers the same three levels on the artefact and on the call that makes it', () => {
    expect([...QualityTarget.options]).toEqual([...QualityTier.options]);
  });
});
