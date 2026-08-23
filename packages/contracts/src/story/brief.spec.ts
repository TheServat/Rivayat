import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { fixtureId, issuePaths } from './__fixtures__/support';
import { twoEpisodeSeriesBible } from './__fixtures__/two-episode-series';
import {
  BRIEF_KINDS,
  Brief,
  BriefEnvelope,
  BriefKind,
  ContentConstraints,
  EpisodeCountIntent,
  INTAKE_STAGES,
  IntakeOptions,
  IntakeStage,
  ReferenceMaterial,
  ScriptFormat,
  SourceDocument,
  StoryModelOverride,
  StoryModelProvider,
} from './brief';

const envelope = {
  language: 'fa',
  targetAudience: 'Persian-speaking adults who grew up on 90s fantasy anime',
  toneWords: ['melancholy', 'wry'],
  targetEpisodeDurationMs: 600_000,
  episodes: { episodesPerSeason: 8 },
  constraints: {},
};

describe('SourceDocument', () => {
  it('takes a whole screenplay, where Prose would not', () => {
    const script = 'INT. LAMP ROOM - NIGHT\n'.repeat(2_000);
    expect(SourceDocument.safeParse(script).success).toBe(true);
    expect(script.length).toBeGreaterThan(20_000);
  });

  it('rejects an empty or whitespace-only document', () => {
    expect(SourceDocument.safeParse('').success).toBe(false);
    expect(SourceDocument.safeParse('   \n  ').success).toBe(false);
  });

  it('refuses a document past the intake ceiling', () => {
    expect(SourceDocument.safeParse('x'.repeat(400_001)).success).toBe(false);
  });
});

describe('ScriptFormat', () => {
  it('names only the conventions the splitter can handle', () => {
    expect(ScriptFormat.options).toEqual(['fountain', 'final-draft-text', 'plain']);
    expect(ScriptFormat.safeParse('fdx').success).toBe(false);
  });
});

describe('ReferenceMaterial', () => {
  const reference = {
    kind: 'image',
    source: 'https://example.invalid/moodboard.png',
    influence: 'style',
    note: 'Copy the flat cel shading and the limited palette; ignore the character designs.',
  };

  it('parses a complete reference', () => {
    expect(ReferenceMaterial.safeParse(reference).success).toBe(true);
  });

  it('points at the offending field when the influence is not routable', () => {
    const result = ReferenceMaterial.safeParse({ ...reference, influence: 'vibes' });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toEqual(['influence']);
  });

  it('rejects a reference with nowhere to fetch it from', () => {
    const result = ReferenceMaterial.safeParse({ ...reference, source: '' });
    expect(issuePaths(result)).toEqual(['source']);
  });
});

describe('ContentConstraints', () => {
  it('defaults to no prohibitions and a teen ceiling', () => {
    expect(ContentConstraints.parse({})).toEqual({ mustNotAppear: [], ratingCeiling: 'teen' });
  });

  it('keeps prohibitions verbatim so they can be checked against a shot', () => {
    const parsed = ContentConstraints.parse({
      mustNotAppear: ['visible blood', 'real-world brand logos'],
      ratingCeiling: 'all-ages',
    });
    expect(parsed.mustNotAppear).toEqual(['visible blood', 'real-world brand logos']);
  });

  it('rejects a prohibition list long enough to be a dump', () => {
    const result = ContentConstraints.safeParse({
      mustNotAppear: Array.from({ length: 65 }, (_, i) => `thing ${String(i)}`),
    });
    expect(issuePaths(result)).toEqual(['mustNotAppear']);
  });
});

describe('EpisodeCountIntent', () => {
  it('defaults to a single closed-ended season', () => {
    expect(EpisodeCountIntent.parse({ episodesPerSeason: 6 })).toEqual({
      seasons: 1,
      episodesPerSeason: 6,
      openEnded: false,
    });
  });

  it('rejects zero episodes, which is not a shorter series but no series', () => {
    expect(issuePaths(EpisodeCountIntent.safeParse({ episodesPerSeason: 0 }))).toEqual([
      'episodesPerSeason',
    ]);
  });

  it('rejects a negative or fractional count', () => {
    expect(EpisodeCountIntent.safeParse({ episodesPerSeason: -3 }).success).toBe(false);
    expect(EpisodeCountIntent.safeParse({ episodesPerSeason: 2.5 }).success).toBe(false);
    expect(EpisodeCountIntent.safeParse({ episodesPerSeason: 4, seasons: 0 }).success).toBe(false);
  });
});

describe('BriefEnvelope', () => {
  it('parses the shared half on its own, applying its defaults', () => {
    const parsed = BriefEnvelope.parse(envelope);
    expect(parsed.language).toBe('fa');
    expect(parsed.references).toEqual([]);
    expect(parsed.episodes.seasons).toBe(1);
  });

  it('rejects an unknown key rather than dropping it silently', () => {
    const result = BriefEnvelope.safeParse({ ...envelope, budget: 12 });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toEqual(['']);
  });

  it('rejects a zero-length episode', () => {
    expect(
      issuePaths(BriefEnvelope.safeParse({ ...envelope, targetEpisodeDurationMs: 0 })),
    ).toEqual(['targetEpisodeDurationMs']);
  });

  it('rejects a negative episode duration', () => {
    expect(BriefEnvelope.safeParse({ ...envelope, targetEpisodeDurationMs: -1 }).success).toBe(
      false,
    );
  });

  it('insists on at least one tone word and at most twelve', () => {
    expect(issuePaths(BriefEnvelope.safeParse({ ...envelope, toneWords: [] }))).toEqual([
      'toneWords',
    ]);
    expect(
      BriefEnvelope.safeParse({
        ...envelope,
        toneWords: Array.from({ length: 13 }, () => 'wry'),
      }).success,
    ).toBe(false);
  });

  it('reports the nested path when the envelope is wrong deep down', () => {
    const result = BriefEnvelope.safeParse({
      ...envelope,
      episodes: { episodesPerSeason: 0 },
    });
    expect(issuePaths(result)).toEqual(['episodes.episodesPerSeason']);
  });
});

describe('BriefKind', () => {
  it('lists the five front doors', () => {
    expect(BriefKind.options).toEqual([...BRIEF_KINDS]);
  });
});

describe('Brief - the discriminated union', () => {
  const byKind = {
    idea: { kind: 'idea', ...envelope, idea: 'A lighthouse keeper who will not grieve.' },
    logline: {
      kind: 'logline',
      ...envelope,
      logline: 'A keeper must out-argue the sea to keep her drowned daughter remembered rightly.',
    },
    script: {
      kind: 'script',
      ...envelope,
      script: 'INT. LAMP ROOM - NIGHT\n\nMAHTAB climbs.',
      scriptFormat: 'fountain',
    },
    prose: {
      kind: 'prose',
      ...envelope,
      prose: 'The water on the floor did not run downhill.',
      excerptOf: 'The Tide That Remembers',
    },
    'series-bible': { kind: 'series-bible', ...envelope, bible: twoEpisodeSeriesBible },
  } as const;

  it.each(BRIEF_KINDS)('routes %s to its own branch', (kind) => {
    const parsed = Brief.parse(byKind[kind]);
    expect(parsed.kind).toBe(kind);
  });

  it('keeps the branch payload rather than flattening it away', () => {
    const parsed = Brief.parse(byKind.script);
    expect(parsed.kind === 'script' && parsed.scriptFormat).toBe('fountain');
  });

  it('imports an existing bible whole, seasons and all', () => {
    const parsed = Brief.parse(byKind['series-bible']);
    expect(parsed.kind === 'series-bible' && parsed.bible.seasons[0]?.episodes).toHaveLength(2);
  });

  it('rejects a kind nobody declared, and says so on the discriminator', () => {
    const result = Brief.safeParse({ kind: 'novel', ...envelope, prose: 'x' });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toEqual(['kind']);
  });

  it('refuses an idea payload wearing the script label', () => {
    const result = Brief.safeParse({
      kind: 'script',
      ...envelope,
      idea: 'A lighthouse keeper who will not grieve.',
    });
    expect(result.success).toBe(false);
    // Both halves of the mismatch are reported: what is missing, and what does not belong.
    expect(issuePaths(result)).toContain('script');
    expect(issuePaths(result)).toContain('scriptFormat');
    expect(issuePaths(result)).toContain('');
  });

  it('refuses a script branch carrying a summary instead of the script', () => {
    const result = Brief.safeParse({ ...byKind.script, script: '' });
    expect(issuePaths(result)).toEqual(['script']);
  });

  it('validates the imported bible instead of trusting it', () => {
    const result = Brief.safeParse({
      kind: 'series-bible',
      ...envelope,
      bible: { ...twoEpisodeSeriesBible, seasons: [] },
    });
    expect(issuePaths(result)).toEqual(['bible.seasons']);
  });
});

describe('IntakeStage', () => {
  it('excludes intake itself and the human preview stage', () => {
    expect(IntakeStage.options).toEqual([...INTAKE_STAGES]);
    expect(IntakeStage.safeParse('intake').success).toBe(false);
    expect(IntakeStage.safeParse('preview').success).toBe(false);
    expect(IntakeStage.safeParse('story').success).toBe(true);
  });
});

describe('StoryModelOverride', () => {
  it('accepts each of the three backends the owner requires', () => {
    expect(StoryModelProvider.options).toEqual(['ollama', 'gemini', 'openrouter']);
    for (const provider of StoryModelProvider.options) {
      expect(StoryModelOverride.safeParse({ provider, model: 'some-model' }).success).toBe(true);
    }
  });

  it('rejects a backend with no adapter behind it', () => {
    const result = StoryModelOverride.safeParse({ provider: 'anthropic', model: 'x' });
    expect(issuePaths(result)).toEqual(['provider']);
  });

  it('bounds temperature and refuses a zero token cap', () => {
    const base = { provider: 'ollama', model: 'qwen3.5:32b' };
    expect(StoryModelOverride.safeParse({ ...base, temperature: 0 }).success).toBe(true);
    expect(StoryModelOverride.safeParse({ ...base, temperature: 2 }).success).toBe(true);
    expect(issuePaths(StoryModelOverride.safeParse({ ...base, temperature: 2.1 }))).toEqual([
      'temperature',
    ]);
    expect(issuePaths(StoryModelOverride.safeParse({ ...base, temperature: -0.1 }))).toEqual([
      'temperature',
    ]);
    expect(issuePaths(StoryModelOverride.safeParse({ ...base, maxOutputTokens: 0 }))).toEqual([
      'maxOutputTokens',
    ]);
  });
});

describe('IntakeOptions', () => {
  it('defaults to running nothing automatically and overriding nothing', () => {
    const parsed = IntakeOptions.parse({ costCeilingNanoUsd: 5_000_000 });
    expect(parsed.autoRun).toEqual([]);
    expect(parsed.modelOverrides).toEqual({});
  });

  it('takes a model for some stages and leaves the rest to the router', () => {
    const parsed = IntakeOptions.parse({
      autoRun: ['style', 'story'],
      modelOverrides: {
        story: { provider: 'openrouter', model: 'google/gemini-3.1-pro' },
        world: { provider: 'ollama', model: 'gemma4:12b', temperature: 0.4 },
      },
      costCeilingNanoUsd: 0,
    });
    expect(Object.keys(parsed.modelOverrides)).toEqual(['story', 'world']);
    expect(parsed.modelOverrides.cast).toBeUndefined();
  });

  it('treats a zero ceiling as a legal dry run, not as a missing value', () => {
    expect(IntakeOptions.parse({ costCeilingNanoUsd: 0 }).costCeilingNanoUsd).toBe(0);
  });

  it('demands a ceiling, because a default ceiling is one nobody chose', () => {
    const result = IntakeOptions.safeParse({});
    expect(issuePaths(result)).toEqual(['costCeilingNanoUsd']);
  });

  it('rejects a negative ceiling and a fractional nano-dollar', () => {
    expect(IntakeOptions.safeParse({ costCeilingNanoUsd: -1 }).success).toBe(false);
    expect(IntakeOptions.safeParse({ costCeilingNanoUsd: 1.5 }).success).toBe(false);
  });

  it('rejects an override keyed by a stage that does not exist', () => {
    const result = IntakeOptions.safeParse({
      costCeilingNanoUsd: 1,
      modelOverrides: { intake: { provider: 'ollama', model: 'x' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unrunnable stage in autoRun', () => {
    const result = IntakeOptions.safeParse({ costCeilingNanoUsd: 1, autoRun: ['preview'] });
    expect(issuePaths(result)).toEqual(['autoRun.0']);
  });
});

describe('JSON Schema for the intake model', () => {
  it('emits a closed object for every schema the model fills', () => {
    for (const schema of [
      BriefEnvelope,
      ReferenceMaterial,
      ContentConstraints,
      EpisodeCountIntent,
      StoryModelOverride,
      IntakeOptions,
    ]) {
      const json = z.toJSONSchema(schema) as { additionalProperties?: unknown };
      expect(json.additionalProperties).toBe(false);
    }
  });

  it('emits one closed branch per brief kind', () => {
    const json = z.toJSONSchema(Brief) as {
      oneOf?: { additionalProperties?: unknown; properties?: { kind?: { const?: string } } }[];
    };
    expect(json.oneOf).toHaveLength(BRIEF_KINDS.length);
    for (const branch of json.oneOf ?? []) {
      expect(branch.additionalProperties).toBe(false);
    }
    expect((json.oneOf ?? []).map((branch) => branch.properties?.kind?.const)).toEqual([
      ...BRIEF_KINDS,
    ]);
  });

  it('carries the field instructions through into the schema the model reads', () => {
    const json = z.toJSONSchema(BriefEnvelope) as {
      properties?: Record<string, { description?: string }>;
    };
    for (const key of ['targetAudience', 'toneWords', 'targetEpisodeDurationMs']) {
      expect(json.properties?.[key]?.description ?? '').not.toBe('');
    }
  });
});

describe('fixture support', () => {
  it('mints ids the primitive schemas accept', () => {
    expect(fixtureId('ser', 1)).toMatch(/^ser_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('reports no paths for a successful parse', () => {
    expect(issuePaths(BriefEnvelope.safeParse(envelope))).toEqual([]);
  });
});
