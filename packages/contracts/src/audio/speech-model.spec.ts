/**
 * The voice catalogue, pinned against drift.
 *
 * The numbers in `KNOWN_SPEECH_MODELS` were live-checked on 2026-08-24 and are asserted
 * here field by field. Treat a failing assertion the way `format.spec.ts` says to treat
 * one of its own: **the vendor changed, go re-verify** - never "the test is out of date".
 *
 * The assertion that matters most is the Persian one. The series language is Persian; if
 * `CHATTERBOX_MULTILINGUAL_LANGUAGES` ever silently gains `fa`, the router will start
 * sending Persian dialogue to weights that cannot speak it, and the result will be
 * fluent, confident and wrong - which passes every other check in this repository.
 */

import { describe, expect, it } from 'vitest';

import type { SpeechCapabilities } from './speech-model';
import {
  CHATTERBOX_MULTILINGUAL_LANGUAGES,
  KNOWN_SPEECH_MODELS,
  SpeechModelDescriptor,
  SpeechUsage,
  UNPRICED_SPEECH,
  describeSpeechPricing,
  findSpeechModel,
  speaksLanguage,
  speechPricingFor,
} from './speech-model';

function capabilities(overrides: Partial<SpeechCapabilities> = {}): SpeechCapabilities {
  return {
    emotionControl: 'scalar',
    clonesFromExemplar: true,
    selectsPresetVoice: false,
    acceptsSeed: true,
    returnsAlignment: false,
    languages: ['en'],
    maxCharactersPerRequest: null,
    sampleRateHz: 24_000,
    watermarks: false,
    ...overrides,
  };
}

describe('the shipped catalogue', () => {
  it('parses, every entry', () => {
    for (const model of KNOWN_SPEECH_MODELS) {
      const result = SpeechModelDescriptor.safeParse(model);
      expect(result.success, `${model.provider}:${model.id}`).toBe(true);
    }
  });

  it('cites a source for every entry, because an unsourced capability is a guess', () => {
    for (const model of KNOWN_SPEECH_MODELS) {
      expect(model.verifiedFrom.length, `${model.id}`).toBeGreaterThan(40);
      expect(model.verifiedFrom).toContain('2026-08-24');
    }
  });

  it('records that Chatterbox does not speak Persian on stock weights', () => {
    // Read out of SUPPORTED_LANGUAGES in chatterbox/mtl_tts.py, chatterbox-tts 0.1.7.
    expect(CHATTERBOX_MULTILINGUAL_LANGUAGES).toHaveLength(23);
    expect(CHATTERBOX_MULTILINGUAL_LANGUAGES).not.toContain('fa');
    const chatterbox = findSpeechModel('chatterbox', 'ResembleAI/chatterbox-multilingual');
    expect(speaksLanguage(chatterbox?.capabilities ?? capabilities(), 'fa')).toBe(false);
  });

  it('records that Higgs does, which is why it is the default for dialogue', () => {
    const higgs = findSpeechModel('higgs', 'bosonai/higgs-tts-3-4b');
    expect(higgs).toBeDefined();
    expect(speaksLanguage(higgs?.capabilities ?? capabilities(), 'fa')).toBe(true);
    expect(higgs?.capabilities.emotionControl).toBe('named-tags');
    expect(higgs?.capabilities.sampleRateHz).toBe(24_000);
    expect(higgs?.pricing.free).toBe(true);
  });

  it('records that Chatterbox always watermarks, which is a shipping decision not a detail', () => {
    expect(
      findSpeechModel('chatterbox', 'ResembleAI/chatterbox-multilingual')?.capabilities.watermarks,
    ).toBe(true);
  });

  it('pins the ElevenLabs rates and limits that were published', () => {
    expect(findSpeechModel('elevenlabs', 'eleven_v3')?.pricing.perKCharactersUsd).toBe('0.10');
    expect(findSpeechModel('elevenlabs', 'eleven_v3')?.capabilities.maxCharactersPerRequest).toBe(
      5000,
    );
    expect(findSpeechModel('elevenlabs', 'eleven_flash_v2_5')?.pricing.perKCharactersUsd).toBe(
      '0.05',
    );
    expect(
      findSpeechModel('elevenlabs', 'eleven_multilingual_v2')?.capabilities.maxCharactersPerRequest,
    ).toBe(10_000);
  });

  it('marks only v3 as tag-driven, because the older models read a tag aloud', () => {
    expect(findSpeechModel('elevenlabs', 'eleven_v3')?.capabilities.emotionControl).toBe(
      'named-tags',
    );
    expect(
      findSpeechModel('elevenlabs', 'eleven_multilingual_v2')?.capabilities.emotionControl,
    ).toBe('voice-settings');
  });

  it('leaves a language list empty where the documentation was ambiguous', () => {
    // Empty means "we did not verify", which `speaksLanguage` reads as "do not refuse".
    // Writing `['fa']` here on a hunch is exactly the failure this file is against.
    const v2 = findSpeechModel('elevenlabs', 'eleven_multilingual_v2');
    expect(v2?.capabilities.languages).toEqual([]);
    expect(speaksLanguage(v2?.capabilities ?? capabilities(), 'fa')).toBe(true);
  });

  it('says nothing about a sample rate the vendor did not state', () => {
    expect(findSpeechModel('elevenlabs', 'eleven_v3')?.capabilities.sampleRateHz).toBeNull();
  });
});

describe('SpeechModelDescriptor refinements', () => {
  const base = {
    provider: 'higgs' as const,
    id: 'test/weights',
    label: 'Test',
    capabilities: capabilities() as unknown as Record<string, unknown>,
    pricing: { perKCharactersUsd: '0', free: true },
    verifiedFrom: 'read from the model card shipped with the weights on 2026-08-24',
  };

  it('refuses a free voice that quotes a nonzero rate', () => {
    const result = SpeechModelDescriptor.safeParse({
      ...base,
      pricing: { perKCharactersUsd: '0.10', free: true },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['pricing']);
  });

  it('accepts a free voice quoting an explicit zero', () => {
    expect(SpeechModelDescriptor.safeParse(base).success).toBe(true);
  });

  it('refuses a named-tag engine that does not say where its tags came from', () => {
    // An unsourced tag vocabulary means an adapter has to guess a syntax, and a guessed
    // tag is one the audience hears read aloud.
    const result = SpeechModelDescriptor.safeParse({
      ...base,
      capabilities: capabilities({ emotionControl: 'named-tags' }),
      verifiedFrom: 'somewhere',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['verifiedFrom']);
  });

  it('does not demand a citation from an engine with no tag vocabulary to get wrong', () => {
    expect(
      SpeechModelDescriptor.safeParse({
        ...base,
        capabilities: capabilities({ emotionControl: 'scalar' }),
        verifiedFrom: 'somewhere',
      }).success,
    ).toBe(true);
  });
});

describe('speaksLanguage', () => {
  it('matches on the primary subtag, because that is what an engine takes', () => {
    expect(speaksLanguage(capabilities({ languages: ['fa'] }), 'fa-IR')).toBe(true);
  });

  it('refuses a language a declared list does not contain', () => {
    expect(speaksLanguage(capabilities({ languages: ['en'] }), 'fa')).toBe(false);
  });

  it('answers yes when nothing was verified, because ignorance is not refusal', () => {
    expect(speaksLanguage(capabilities({ languages: [] }), 'fa')).toBe(true);
  });
});

describe('pricing helpers', () => {
  it('finds a price, or hands back the unpriced record rather than a free one', () => {
    expect(speechPricingFor('elevenlabs', 'eleven_v3').perKCharactersUsd).toBe('0.10');
    expect(speechPricingFor('higgs', 'nobody/knows')).toEqual(UNPRICED_SPEECH);
    expect(UNPRICED_SPEECH.free).toBe(false);
  });

  it('returns undefined for a model in the catalogue under a different provider', () => {
    expect(findSpeechModel('higgs', 'eleven_v3')).toBeUndefined();
  });

  it('reads an injected catalogue', () => {
    expect(findSpeechModel('higgs', 'bosonai/higgs-tts-3-4b', [])).toBeUndefined();
    expect(speechPricingFor('higgs', 'bosonai/higgs-tts-3-4b', [])).toEqual(UNPRICED_SPEECH);
  });

  it('never renders "not published" the same way as "free"', () => {
    expect(describeSpeechPricing({ perKCharactersUsd: '0', free: true })).toBe('free');
    expect(describeSpeechPricing(UNPRICED_SPEECH)).toBe('no published price');
    expect(describeSpeechPricing({ perKCharactersUsd: null, free: false })).toBe(
      'price not published',
    );
  });

  it('renders a rate the way the vendor quotes it, with the caveat attached', () => {
    expect(describeSpeechPricing({ perKCharactersUsd: '0.10', free: false })).toBe(
      '$0.10/1K characters',
    );
    expect(
      describeSpeechPricing({ perKCharactersUsd: '0.05', free: false, note: 'half of v3' }),
    ).toBe('$0.05/1K characters - half of v3');
  });
});

describe('SpeechUsage', () => {
  it('counts characters sent and audio produced, and defaults the length to zero', () => {
    expect(SpeechUsage.parse({ characters: 68 })).toEqual({ characters: 68, audioMs: 0 });
  });

  it('refuses a negative count', () => {
    expect(SpeechUsage.safeParse({ characters: -1 }).success).toBe(false);
  });
});
