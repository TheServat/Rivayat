/**
 * Casting: the one field that encodes "the narrator is me, the characters are AI", and
 * the two refinements that stop it being quietly undone.
 */

import { describe, expect, it } from 'vitest';

import { Ids } from '../primitives/ids';
import {
  PERSIAN,
  VoiceCasting,
  VoiceExemplar,
  VoiceProfile,
  isNarrated,
  primarySubtag,
  voiceFor,
} from './voice';

const ids = new Ids();
const NARRATOR = ids.entity();
const MAHTAB = ids.entity();
const KAEL = ids.entity();

function exemplar(): unknown {
  return {
    sha256: 'a'.repeat(64),
    mimeType: 'audio/wav',
    bytes: 480_000,
    durationMs: 10_000,
    sampleRateHz: 24_000,
    language: 'fa',
    transcript: 'یک جملهٔ نمونه برای همسان‌سازی صدا.',
  };
}

function narratorProfile(overrides: Record<string, unknown> = {}): unknown {
  return {
    role: 'narrator',
    performedBy: 'human',
    speakerRef: NARRATOR,
    label: 'راوی',
    language: 'fa',
    binding: {},
    rationale: 'the owner, reading their own series',
    ...overrides,
  };
}

function characterProfile(overrides: Record<string, unknown> = {}): unknown {
  return {
    role: 'character',
    performedBy: 'synthetic',
    speakerRef: MAHTAB,
    label: 'مهتاب',
    language: 'fa',
    binding: { exemplar: exemplar() },
    expressiveness: 0.35,
    rationale: 'terse and formal, and the silence before she answers is the point',
    ...overrides,
  };
}

describe('LanguageTag', () => {
  it('accepts the shapes the three engines actually want', () => {
    for (const tag of ['fa', 'en', 'fa-IR', 'en-GB', 'zh-Hans-CN']) {
      expect(VoiceProfile.shape.language.safeParse(tag).success, tag).toBe(true);
    }
  });

  it('refuses something that is not a tag at all', () => {
    for (const tag of ['Persian', 'FA', '', 'fa_IR']) {
      expect(VoiceProfile.shape.language.safeParse(tag).success, tag).toBe(false);
    }
  });

  it('takes the primary subtag, which is the part every engine agrees on', () => {
    expect(primarySubtag('fa-IR')).toBe('fa');
    expect(primarySubtag('fa')).toBe('fa');
    expect(PERSIAN).toBe('fa');
  });
});

describe('VoiceExemplar', () => {
  it('requires a transcript, because an exemplar without one clones worse', () => {
    const withoutTranscript = { ...(exemplar() as Record<string, unknown>) };
    delete withoutTranscript.transcript;
    expect(VoiceExemplar.safeParse(withoutTranscript).success).toBe(false);
  });

  it('addresses the clip by content, so a voice cannot change under a series', () => {
    const parsed = VoiceExemplar.parse(exemplar());
    expect(parsed.sha256).toHaveLength(64);
  });
});

describe('VoiceCasting', () => {
  function casting(overrides: Record<string, unknown> = {}): unknown {
    return {
      narratorRef: NARRATOR,
      language: 'fa',
      profiles: [narratorProfile(), characterProfile()],
      ...overrides,
    };
  }

  it('accepts the shape the owner asked for: one human narrator, synthetic characters', () => {
    const parsed = VoiceCasting.parse(casting());
    expect(parsed.narratorRef).toBe(NARRATOR);
    expect(voiceFor(parsed, NARRATOR)?.performedBy).toBe('human');
    expect(voiceFor(parsed, MAHTAB)?.performedBy).toBe('synthetic');
  });

  it('refuses to let a machine read a human voice', () => {
    // The failure this exists to stop surfaces nowhere but the finished episode.
    const result = VoiceCasting.safeParse(
      casting({
        profiles: [narratorProfile({ binding: { presetId: 'some-voice' } }), characterProfile()],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['profiles', 0, 'binding']);
  });

  it('refuses a synthetic voice with nothing to synthesise from', () => {
    // The quieter mirror: every line would arrive in whatever the engine felt like.
    const result = VoiceCasting.safeParse(
      casting({ profiles: [narratorProfile(), characterProfile({ binding: {} })] }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['profiles', 1, 'binding']);
  });

  it('refuses two voices for one speaker', () => {
    const result = VoiceCasting.safeParse(
      casting({
        profiles: [narratorProfile(), characterProfile(), characterProfile({ label: 'دیگر' })],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.includes('speakerRef'))).toBe(true);
  });

  it('refuses a narrator who was named but never cast', () => {
    const result = VoiceCasting.safeParse(casting({ profiles: [characterProfile()] }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['narratorRef']);
  });

  it('refuses the narrator entity cast in a character role', () => {
    const result = VoiceCasting.safeParse(
      casting({
        profiles: [
          narratorProfile({
            role: 'character',
            performedBy: 'synthetic',
            binding: { presetId: 'x' },
          }),
          characterProfile(),
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['profiles', 0, 'role']);
  });

  it('refuses anyone else claiming the narrator role', () => {
    const result = VoiceCasting.safeParse(
      casting({
        profiles: [narratorProfile(), characterProfile({ role: 'narrator' })],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['profiles', 1, 'role']);
  });

  it('allows a series with no narrator at all', () => {
    const parsed = VoiceCasting.parse(
      casting({ narratorRef: null, profiles: [characterProfile()] }),
    );
    expect(isNarrated(parsed, MAHTAB)).toBe(false);
  });

  it('allows a synthetic narrator, for a series the owner does not read', () => {
    const parsed = VoiceCasting.parse(
      casting({
        profiles: [
          narratorProfile({ performedBy: 'synthetic', binding: { presetId: 'a-voice' } }),
          characterProfile(),
        ],
      }),
    );
    expect(voiceFor(parsed, NARRATOR)?.performedBy).toBe('synthetic');
    // Still the narrator: the role is the narrative function, not who performs it.
    expect(isNarrated(parsed, NARRATOR)).toBe(true);
  });

  it('answers the narration question for exactly one speaker', () => {
    const parsed = VoiceCasting.parse(casting());
    expect(isNarrated(parsed, NARRATOR)).toBe(true);
    expect(isNarrated(parsed, MAHTAB)).toBe(false);
  });

  it('returns undefined for a speaker nobody cast', () => {
    expect(voiceFor(VoiceCasting.parse(casting()), KAEL)).toBeUndefined();
  });

  it('defaults the biases to no opinion, so an unstated voice is the engine default', () => {
    const parsed = VoiceProfile.parse(characterProfile());
    expect(parsed.pitchBias).toBe(0);
    expect(parsed.tempoBias).toBe(0);
  });

  it('defaults a profile to synthetic, which fails loudly rather than silently', () => {
    const withoutPerformer = { ...(characterProfile() as Record<string, unknown>) };
    delete withoutPerformer.performedBy;
    // A voice that should have been human shows up as an unexpected cost in the estimate
    // before the run; one that should have been synthetic shows up as silence in an
    // episode. The default points at the recoverable failure.
    expect(VoiceProfile.parse(withoutPerformer).performedBy).toBe('synthetic');
  });

  it('requires a rationale, because a voice nobody can check against the sheet is a knob', () => {
    const withoutRationale = { ...(characterProfile() as Record<string, unknown>) };
    delete withoutRationale.rationale;
    expect(VoiceProfile.safeParse(withoutRationale).success).toBe(false);
  });
});
