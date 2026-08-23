import { StyleBibleDraft } from '@rv/contracts';
import { StructuredCall } from '@rv/prompt-kit';
import {
  MemoryLogger,
  ProviderError,
  isErr,
  isOk,
  ok as okResult,
  sha256,
  stableStringify,
} from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import {
  FakeRaster,
  ScriptedBackend,
  imagePayload,
  stripedImage,
  testClock,
} from '../__fixtures__/fakes';
import { STYLE_PRESETS } from '../presets/index';
import { compilePromptFragments } from '../prompts/compile';
import { DeriveStyleFromReferencesUseCase, type StyleReference } from './derive-style';
import type { StyleObservations } from './observations';

const MOSS = [0x4a, 0x6b, 0x3f] as const;
const BARK = [0x5a, 0x46, 0x32] as const;
const SKY = [0xcf, 0xe3, 0xef] as const;

function observations(overrides: Partial<StyleObservations> = {}): StyleObservations {
  return {
    surface: { impression: 'cut-paper', evidence: 'every element has a visible torn fibre edge' },
    outline: {
      present: false,
      thickness: 'none',
      uniformity: 'uniform',
      colour: 'no-outline',
      steadiness: 'ruler-straight',
      tapered: false,
    },
    shading: {
      bands: 2,
      edge: 'hard',
      lightFrom: 'upper-left',
      rimLight: 'none',
      contactShadows: 'deep',
    },
    texture: {
      grain: 'subtle',
      paperFibre: 'dominant',
      halftone: 'none',
      brushMarks: 'none',
      edgeRaggedness: 'dominant',
    },
    forms: {
      corners: 'mixed',
      proportions: 'clearly-stylised',
      headsPerBody: 4.5,
      detail: 'sparse',
      readableAsSilhouette: true,
    },
    background: 'stacked-depth-layers',
    colourRelationship: 'earthy',
    valueContrast: 'moderate',
    colours: [
      { hex: '#4a6b3f', name: 'moss', where: 'the canopy' },
      { hex: '#5a4632', name: 'bark', where: 'the trunk' },
      { hex: '#cfe3ef', name: 'sky', where: 'behind everything' },
    ],
    organicColours: ['#e2b48c'],
    notablyAbsent: ['photographic depth of field', 'glowing highlights'],
    ...overrides,
  };
}

const VALID = JSON.stringify(observations());

function references(count = 2): readonly StyleReference[] {
  return Array.from({ length: count }, (_, index) => ({
    image: imagePayload(`reference-${String(index)}`),
  }));
}

function useCase(
  backends: readonly ScriptedBackend[],
  raster?: FakeRaster,
): { subject: DeriveStyleFromReferencesUseCase; logger: MemoryLogger } {
  const logger = new MemoryLogger();
  const subject = new DeriveStyleFromReferencesUseCase({
    structuredCall: new StructuredCall({ clock: testClock(), logger }),
    backends,
    ...(raster === undefined ? {} : { raster }),
    logger,
  });
  return { subject, logger };
}

const decodesTo = (): FakeRaster => new FakeRaster([okResult(stripedImage([MOSS, BARK, SKY]))]);

describe('DeriveStyleFromReferencesUseCase', () => {
  it('proposes a draft that parses, with every reference registered as an anchor', async () => {
    const { subject } = useCase([new ScriptedBackend('ollama:vision', [VALID])]);
    const refs: readonly StyleReference[] = [
      { image: imagePayload('a'), role: 'palette-source', note: 'the key frame' },
      { image: imagePayload('b'), role: 'counter-example' },
    ];

    const result = await subject.execute({ references: refs, name: 'Paper Grove', seed: 4242 });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(() => StyleBibleDraft.parse(result.value.draft)).not.toThrow();
    expect(result.value.draft.origin).toBe('derived');
    expect(result.value.draft.seed).toBe(4242);
    expect(result.value.draft.anchors).toEqual([
      { imageHash: sha256(refs[0]!.image.data), role: 'palette-source', note: 'the key frame' },
      { imageHash: sha256(refs[1]!.image.data), role: 'counter-example' },
    ]);
  });

  it('sends the reference images through StructuredCall rather than a bespoke vision call', async () => {
    const backend = new ScriptedBackend('ollama:vision', [VALID]);
    const { subject } = useCase([backend]);

    await subject.execute({ references: references(3), name: 'Ref', seed: 1 });

    const request = backend.requests[0];
    expect(request).toBeDefined();
    const withImages = request?.messages.find((message) => message.images !== undefined);
    expect(withImages?.images).toHaveLength(3);
    expect(withImages?.images?.[0]?.mimeType).toBe('image/png');
    // The schema goes out on every call - `StructuredCall` decides what to do with it.
    expect(request?.jsonSchema).toBeDefined();
  });

  it('derives the prompt fragments rather than asking the model for them', () => {
    // Guarded here as well as in the preset suite: derivation is the path where it
    // would be most tempting to let a model write the prompt it just described.
    expect.assertions(1);
    return useCase([new ScriptedBackend('ollama:vision', [VALID])])
      .subject.execute({ references: references(), name: 'Ref', seed: 7 })
      .then((result) => {
        if (!isOk(result)) throw new Error('expected ok');
        expect(compilePromptFragments({ visual: result.value.draft.visual })).toEqual(
          result.value.draft.prompts,
        );
      });
  });

  it('inherits motion from the preset for the observed medium, and says so', async () => {
    const { subject } = useCase([new ScriptedBackend('ollama:vision', [VALID])]);
    const result = await subject.execute({ references: references(), name: 'Ref', seed: 1 });
    if (!isOk(result)) throw new Error('expected ok');

    // A still reference cannot testify about movement; guessing would corrupt the one
    // block whose purpose is to keep look and motion together.
    const paperCutout = STYLE_PRESETS.find((preset) => preset.id === 'paper-cutout');
    expect(result.value.draft.motion).toEqual(paperCutout?.draft.motion);
    expect(result.value.draft.notes).toContain('paper-cutout');
    expect(result.value.draft.notes).toContain('Review it before locking');
  });

  it('maps a different observed surface onto a different medium', async () => {
    const wet = JSON.stringify(
      observations({
        surface: { impression: 'wet-paint', evidence: 'pigment has pooled at every edge' },
      }),
    );
    const { subject } = useCase([new ScriptedBackend('ollama:vision', [wet])]);
    const result = await subject.execute({ references: references(), name: 'Ref', seed: 1 });
    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.draft.visual.medium).toBe('watercolour');
  });

  it('is byte-identical across runs for the same references and seed', async () => {
    const first = await useCase([new ScriptedBackend('ollama:vision', [VALID])]).subject.execute({
      references: references(),
      name: 'Ref',
      seed: 99,
    });
    const second = await useCase([new ScriptedBackend('ollama:vision', [VALID])]).subject.execute({
      references: references(),
      name: 'Ref',
      seed: 99,
    });

    if (!isOk(first) || !isOk(second)) throw new Error('expected ok');
    expect(stableStringify(first.value.draft)).toBe(stableStringify(second.value.draft));
  });
});

describe('DeriveStyleFromReferencesUseCase, when the model misbehaves', () => {
  it('repairs prose into a usable draft rather than failing', async () => {
    // Research §1: Ollama accepts a schema for qwen3.5 and then does not enforce it.
    // This is the case that path exists for.
    const backend = new ScriptedBackend('ollama:vision', [
      'These references are a lovely torn-paper collage with earthy colours.',
      VALID,
    ]);
    const { subject } = useCase([backend]);

    const result = await subject.execute({ references: references(), name: 'Ref', seed: 1 });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.trace.resolution).toBe('repaired');
    expect(result.value.trace.repairTurns).toBe(1);
    expect(backend.requests).toHaveLength(2);
  });

  it('repairs a schema-violating object and records which fields were wrong', async () => {
    const broken = JSON.stringify({
      ...observations(),
      shading: { ...observations().shading, bands: 99 },
      colours: [],
    });
    const { subject } = useCase([new ScriptedBackend('ollama:vision', [broken, VALID])]);

    const result = await subject.execute({ references: references(), name: 'Ref', seed: 1 });

    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.trace.resolution).toBe('repaired');
    expect(result.value.trace.failedPaths.length).toBeGreaterThan(0);
  });

  it('strips a markdown fence without counting it as a repair', async () => {
    const fenced = ['```json', VALID, '```'].join('\n');
    const { subject } = useCase([new ScriptedBackend('ollama:vision', [fenced])]);
    const result = await subject.execute({ references: references(), name: 'Ref', seed: 1 });
    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.trace.resolution).toBe('fence-stripped');
  });

  it('escalates to the next backend and still returns a complete draft', async () => {
    const local = new ScriptedBackend('ollama:vision', ['not json at all']);
    const cloud = new ScriptedBackend('openrouter:vision', [VALID]);
    const { subject } = useCase([local, cloud]);

    const result = await subject.execute({ references: references(), name: 'Ref', seed: 1 });

    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.trace.resolution).toBe('escalated');
    expect(result.value.trace.escalatedTo).toBe('openrouter:vision');
    expect(() => StyleBibleDraft.parse(result.value.draft)).not.toThrow();
  });

  it('returns a typed error rather than a partial bible when nothing works', async () => {
    const { subject, logger } = useCase([new ScriptedBackend('ollama:vision', ['still not json'])]);

    const result = await subject.execute({ references: references(), name: 'Ref', seed: 1 });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.kind).toBe('validation');
    expect(logger.records.some((record) => record.level === 'warn')).toBe(true);
  });

  it('propagates a provider failure as an error', async () => {
    const failing = new ScriptedBackend('ollama:vision', [
      new ProviderError({ provider: 'ollama', message: 'model not loaded' }),
    ]);
    const result = await useCase([failing]).subject.execute({
      references: references(),
      name: 'Ref',
      seed: 1,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.kind).toBe('provider');
  });
});

describe('DeriveStyleFromReferencesUseCase, palette measurement', () => {
  it('prefers the measured palette over the described one', async () => {
    const { subject } = useCase([new ScriptedBackend('ollama:vision', [VALID])], decodesTo());

    const result = await subject.execute({ references: references(1), name: 'Ref', seed: 1 });

    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.measuredPalette).not.toBeNull();
    expect(result.value.draft.visual.palette.colors.map((colour) => colour.hex).sort()).toEqual(
      ['#4a6b3f', '#5a4632', '#cfe3ef'].sort(),
    );
    // Hexes from the pixels, names borrowed from the model - each doing what it is good at.
    expect(result.value.draft.visual.palette.colors.map((colour) => colour.name).sort()).toEqual(
      ['bark', 'moss', 'sky'].sort(),
    );
    expect(result.value.draft.notes).toContain('measured from');
  });

  it('excludes counter-examples from the measurement', async () => {
    const raster = decodesTo();
    const { subject } = useCase([new ScriptedBackend('ollama:vision', [VALID])], raster);

    await subject.execute({
      references: [
        { image: imagePayload('keep') },
        { image: imagePayload('avoid'), role: 'counter-example' },
      ],
      name: 'Ref',
      seed: 1,
    });

    // "Explicitly not this" colours belong in the negative prompt, not the palette.
    expect(raster.calls).toHaveLength(1);
  });

  it('falls back to the described palette when no decoder is wired up', async () => {
    const { subject } = useCase([new ScriptedBackend('ollama:vision', [VALID])]);
    const result = await subject.execute({ references: references(), name: 'Ref', seed: 1 });
    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.measuredPalette).toBeNull();
    expect(result.value.draft.notes).toContain('no pixel decoder');
    expect(result.value.draft.visual.palette.colors.map((colour) => colour.name)).toEqual([
      'moss',
      'bark',
      'sky',
    ]);
  });

  it('degrades to the described palette when a reference cannot be decoded', async () => {
    // Worse colours are still colours; a failed decode must not lose the derivation.
    const raster = new FakeRaster([
      { ok: false, error: new ProviderError({ provider: 'sharp', message: 'not an image' }) },
    ]);
    const { subject, logger } = useCase([new ScriptedBackend('ollama:vision', [VALID])], raster);

    const result = await subject.execute({ references: references(1), name: 'Ref', seed: 1 });

    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.measuredPalette).toBeNull();
    expect(logger.records.some((record) => record.level === 'warn')).toBe(true);
  });
});

describe('DeriveStyleFromReferencesUseCase, input validation', () => {
  it('refuses an empty reference set', async () => {
    const result = await useCase([new ScriptedBackend('ollama:vision', [VALID])]).subject.execute({
      references: [],
      name: 'Ref',
      seed: 1,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.kind).toBe('validation');
  });

  it('refuses a mood board', async () => {
    const result = await useCase([new ScriptedBackend('ollama:vision', [VALID])]).subject.execute({
      references: references(9),
      name: 'Ref',
      seed: 1,
    });
    expect(isErr(result)).toBe(true);
  });

  it('refuses a mime type a vision turn cannot carry, rather than dropping it', async () => {
    // A silent drop would derive the style from the wrong half of the references and
    // say nothing about it.
    const backend = new ScriptedBackend('ollama:vision', [VALID]);
    const result = await useCase([backend]).subject.execute({
      references: [{ image: imagePayload('svg', 'image/svg+xml') }],
      name: 'Ref',
      seed: 1,
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.context).toMatchObject({ mimeType: 'image/svg+xml' });
    expect(backend.requests).toHaveLength(0);
  });
});
