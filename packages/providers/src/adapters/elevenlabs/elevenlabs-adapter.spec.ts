/**
 * ElevenLabs, against fixtures only.
 *
 * **No request in this file has ever been sent to the real API**, because no key exists
 * on this machine. Everything asserted is the *translation* - what we would send, what
 * we would charge for it, and what we would report as lost - plus the parsing of a
 * response shaped the way the documentation says it is shaped. That is worth having, and
 * it is not the same thing as knowing the endpoint accepts it.
 *
 * The tag assertions deserve a note. The rule under test is a refusal: this adapter
 * emits only tags that appear verbatim in the published documentation, and reports every
 * other emotion as dropped. A test that asserted `[bitter]` for bitterness would be
 * asserting an invention, so instead the tests assert the *absence* of an invented tag,
 * which is the property that actually protects the audience from hearing one read aloud.
 */

import { describe, expect, it } from 'vitest';
import type { SpeechDirection, VoiceProfile } from '@rv/contracts';
import { isErr, isOk } from '@rv/shared-kernel';

import { FetchStub } from '../../__fixtures__/fetch-stub';
import { elevenlabs } from '../../__fixtures__/responses';
import { fixedClock } from '../../__fixtures__/support';
import { ElevenLabsAdapter } from './elevenlabs-adapter';

const SPEAKER = `ent_${'0'.repeat(24)}A1`;
const ROUTE = '/with-timestamps';

function voice(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    role: 'character',
    performedBy: 'synthetic',
    speakerRef: SPEAKER,
    label: 'Roya',
    language: 'fa',
    binding: { presetId: 'voice-roya', exemplar: null },
    pitchBias: 0,
    tempoBias: 0,
    expressiveness: 0.5,
    rationale: 'clipped, formal, and never finishes the sentence that would give her away',
    ...overrides,
  };
}

function direction(overrides: Partial<SpeechDirection> = {}): SpeechDirection {
  return {
    emotion: 'neutral',
    intensity: 0.4,
    pace: 'measured',
    volume: 'normal',
    stance: 'plain',
    ...overrides,
  };
}

function build(stub: FetchStub, options: Record<string, unknown> = {}): ElevenLabsAdapter {
  return new ElevenLabsAdapter({
    apiKey: 'xi-test',
    voiceId: 'default-voice',
    fetch: stub.fetch,
    clock: fixedClock(),
    ...options,
  });
}

function stubbed(text = 'سلام'): FetchStub {
  return new FetchStub().on(ROUTE, { json: elevenlabs.speech(text) });
}

async function bodySentFor(
  overrides: {
    text?: string;
    direction?: SpeechDirection;
    voice?: VoiceProfile;
    options?: Record<string, unknown>;
  } = {},
): Promise<Record<string, unknown>> {
  const stub = stubbed();
  await build(stub, overrides.options ?? {}).synthesizeSpeech({
    text: overrides.text ?? 'او رفت.',
    voice: overrides.voice ?? voice(),
    direction: overrides.direction ?? direction(),
    language: 'fa',
  });
  return (stub.requests[0]?.json ?? {}) as Record<string, unknown>;
}

describe('ElevenLabsAdapter tag discipline', () => {
  it('emits no tag for an emotion the documentation does not name', async () => {
    const body = await bodySentFor({ direction: direction({ emotion: 'bitterness' }) });
    expect(body.text).toBe('او رفت.');
    expect(String(body.text)).not.toMatch(/\[/u);
  });

  it('reports that emotion as dropped rather than letting it vanish', async () => {
    const stub = stubbed();
    const outcome = await build(stub).synthesizeSpeech({
      text: 'او رفت.',
      voice: voice(),
      direction: direction({ emotion: 'bitterness' }),
      language: 'fa',
    });
    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    const gap = outcome.value.rendered.dropped.find((entry) => entry.aspect === 'emotion');
    expect(gap?.requested).toBe('bitterness');
    expect(gap?.substituted).toBeNull();
  });

  it('uses the documented tags where there really is one', async () => {
    expect(await bodySentFor({ direction: direction({ volume: 'whisper' }) })).toMatchObject({
      text: '[whispers] او رفت.',
    });
    expect(await bodySentFor({ direction: direction({ stance: 'ironic' }) })).toMatchObject({
      text: '[sarcastic] او رفت.',
    });
    expect(await bodySentFor({ direction: direction({ emotion: 'joy' }) })).toMatchObject({
      text: '[excited] او رفت.',
    });
  });

  it('adds nothing for a sincerely mistaken line', async () => {
    const plain = await bodySentFor({ direction: direction({ emotion: 'relief' }) });
    const mistaken = await bodySentFor({
      direction: direction({ emotion: 'relief', stance: 'mistaken' }),
    });
    expect(mistaken.text).toBe(plain.text);
  });

  it('emits no tag at all on a model that does not support them, and says so', async () => {
    const stub = stubbed();
    const outcome = await build(stub, { model: 'eleven_multilingual_v2' }).synthesizeSpeech({
      text: 'او رفت.',
      voice: voice(),
      direction: direction({ emotion: 'joy', volume: 'whisper', stance: 'ironic' }),
      language: 'fa',
    });

    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    // `[excited]` on v2 is read aloud as the word. Silence is the correct behaviour.
    expect((stub.requests[0]?.json as { text: string }).text).toBe('او رفت.');
    expect(outcome.value.rendered.dropped.map((entry) => entry.aspect).sort()).toEqual([
      'emotion',
      'stance',
      'volume',
    ]);
  });

  it('drops a loudness the tag list has no word for', async () => {
    const stub = stubbed();
    const outcome = await build(stub).synthesizeSpeech({
      text: 'او رفت.',
      voice: voice(),
      direction: direction({ volume: 'raised' }),
      language: 'fa',
    });
    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.rendered.dropped.map((entry) => entry.aspect)).toContain('volume');
  });
});

describe('ElevenLabsAdapter voice settings', () => {
  it('lowers stability as a line is pushed, which is the direction the docs describe', async () => {
    const soft = await bodySentFor({ direction: direction({ intensity: 0.1 }) });
    const hard = await bodySentFor({ direction: direction({ intensity: 1 }) });
    const stabilityOf = (body: Record<string, unknown>): number =>
      (body.voice_settings as { stability: number }).stability;
    expect(stabilityOf(hard)).toBeLessThan(stabilityOf(soft));
  });

  it('raises stability for a concealing line, which is the opposite case', async () => {
    const open = await bodySentFor({ direction: direction({ intensity: 0.8 }) });
    const held = await bodySentFor({
      direction: direction({ intensity: 0.8, stance: 'concealing' }),
    });
    const stabilityOf = (body: Record<string, unknown>): number =>
      (body.voice_settings as { stability: number }).stability;
    expect(stabilityOf(held)).toBeGreaterThan(stabilityOf(open));
  });

  it('keeps speed inside the documented 0.7 to 1.2 range at both extremes', async () => {
    const speedOf = (body: Record<string, unknown>): number =>
      (body.voice_settings as { speed: number }).speed;
    const fastest = await bodySentFor({
      direction: direction({ pace: 'rushed' }),
      voice: voice({ tempoBias: 1 }),
    });
    const slowest = await bodySentFor({
      direction: direction({ pace: 'slow' }),
      voice: voice({ tempoBias: -1 }),
    });
    expect(speedOf(fastest)).toBeLessThanOrEqual(1.2);
    expect(speedOf(slowest)).toBeGreaterThanOrEqual(0.7);
  });

  it('sends the line language as a bare ISO-639-1 code', async () => {
    const stub = stubbed();
    await build(stub).synthesizeSpeech({
      text: 'او رفت.',
      voice: voice(),
      direction: direction(),
      language: 'fa-IR',
    });
    expect((stub.requests[0]?.json as { language_code: string }).language_code).toBe('fa');
  });
});

describe('ElevenLabsAdapter cost', () => {
  it('quotes the tagged text, not the raw line', () => {
    const adapter = build(new FetchStub());
    const raw = adapter.quoteSpeech({ text: 'او رفت.' });
    const whispered = adapter.quoteSpeech({
      text: 'او رفت.',
      direction: direction({ volume: 'whisper' }),
    });
    // '[whispers] ' is eleven billable characters that a caller-side quote would miss.
    expect(whispered.characters).toBe(raw.characters + '[whispers] '.length);
    expect(whispered.kind).toBe('estimated');
  });

  it('prices from the catalogue rate, so the estimate and the invoice share a table', () => {
    const quote = build(new FetchStub()).quoteSpeech({ text: 'x'.repeat(1000) });
    expect(quote.kind).toBe('estimated');
    // $0.10 per 1K characters is $0.10 for exactly 1000 characters.
    if (quote.kind === 'estimated') expect(quote.nanoUsd).toBe(100_000_000);
  });

  it('is cheaper per character on Flash, as the published table says', () => {
    const v3 = build(new FetchStub()).quoteSpeech({ text: 'x'.repeat(1000) });
    const flash = build(new FetchStub(), { model: 'eleven_flash_v2_5' }).quoteSpeech({
      text: 'x'.repeat(1000),
    });
    expect(v3.kind).toBe('estimated');
    expect(flash.kind).toBe('estimated');
    if (v3.kind === 'estimated' && flash.kind === 'estimated') {
      expect(flash.nanoUsd).toBe(v3.nanoUsd / 2);
    }
  });

  it('returns the unpriced arm for a model nobody has priced, never a zero', () => {
    const quote = build(new FetchStub(), { model: 'eleven_something_new' }).quoteSpeech({
      text: 'x',
    });
    expect(quote.kind).toBe('unpriced');
  });

  it('records the characters it really sent in the usage row', async () => {
    const stub = stubbed();
    const outcome = await build(stub).synthesizeSpeech({
      text: 'او رفت.',
      voice: voice(),
      direction: direction({ volume: 'whisper' }),
      language: 'fa',
    });
    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.usage.speech?.characters).toBe('[whispers] او رفت.'.length);
  });
});

describe('ElevenLabsAdapter response handling', () => {
  it('measures the take from the alignment, because MP3 has no header to read', async () => {
    const stub = new FetchStub().on(ROUTE, { json: elevenlabs.speech('abcde') });
    const outcome = await build(stub).synthesizeSpeech({
      text: 'abcde',
      voice: voice(),
      direction: direction(),
      language: 'fa',
    });

    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    // Five characters at 60 ms each in the fixture.
    expect(outcome.value.audio.durationMs).toBe(300);
    expect(outcome.value.alignment?.characters).toHaveLength(5);
    expect(outcome.value.alignment?.startMs[0]).toBe(0);
    expect(outcome.value.audio.mimeType).toBe('audio/mpeg');
  });

  it('refuses an alignment whose arrays disagree, rather than mis-placing every viseme', async () => {
    const broken = elevenlabs.speech('abcde');
    const alignment = broken.alignment as { character_end_times_seconds: number[] };
    alignment.character_end_times_seconds = [0.1];
    delete broken.normalized_alignment;

    const stub = new FetchStub().on(ROUTE, { json: broken });
    const outcome = await build(stub).synthesizeSpeech({
      text: 'abcde',
      voice: voice(),
      direction: direction(),
      language: 'fa',
    });

    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.alignment).toBeNull();
    expect(outcome.value.audio.durationMs).toBeNull();
  });

  it('turns a 200 that is not the documented shape into a retryable provider error', async () => {
    const stub = new FetchStub().on(ROUTE, { json: { detail: 'something else entirely' } });
    const outcome = await build(stub).synthesizeSpeech({
      text: 'او رفت.',
      voice: voice(),
      direction: direction(),
      language: 'fa',
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.kind).toBe('provider');
      expect(outcome.error.retryable).toBe(true);
    }
  });

  it('refuses text past the model ceiling locally, so a 4xx is never paid for', async () => {
    const stub = stubbed();
    const outcome = await build(stub).synthesizeSpeech({
      text: 'x'.repeat(5001),
      voice: voice(),
      direction: direction(),
      language: 'fa',
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.kind).toBe('validation');
    expect(stub.requests).toHaveLength(0);
  });

  it('counts the tags against the ceiling, because the vendor counts what it receives', async () => {
    const stub = stubbed();
    const outcome = await build(stub).synthesizeSpeech({
      // Under the 5,000 ceiling on its own; over it once '[whispers] ' is prefixed.
      text: 'x'.repeat(4995),
      voice: voice(),
      direction: direction({ volume: 'whisper' }),
      language: 'fa',
    });
    expect(isErr(outcome)).toBe(true);
    expect(stub.requests).toHaveLength(0);
  });

  it('prefers the voice bound to the character over the adapter default', async () => {
    const stub = stubbed();
    await build(stub).synthesizeSpeech({
      text: 'او رفت.',
      voice: voice(),
      direction: direction(),
      language: 'fa',
    });
    expect(stub.requests[0]?.url).toContain('/v1/text-to-speech/voice-roya/with-timestamps');
  });

  it('falls back to the adapter default when the character has no bound voice', async () => {
    const stub = stubbed();
    await build(stub).synthesizeSpeech({
      text: 'او رفت.',
      voice: voice({ binding: { presetId: null, exemplar: null } }),
      direction: direction(),
      language: 'fa',
    });
    expect(stub.requests[0]?.url).toContain('/v1/text-to-speech/default-voice/');
  });

  it('reports an exemplar clip as unusable rather than quietly ignoring the cast voice', async () => {
    const stub = stubbed();
    const outcome = await build(stub).synthesizeSpeech({
      text: 'او رفت.',
      voice: voice({
        binding: {
          presetId: 'voice-roya',
          exemplar: {
            sha256: 'a'.repeat(64),
            mimeType: 'audio/wav',
            bytes: 1000,
            durationMs: 8000,
            sampleRateHz: 24_000,
            language: 'fa',
            transcript: 'یک جملهٔ نمونه.',
          },
        },
      }),
      direction: direction(),
      language: 'fa',
    });

    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.rendered.dropped.map((entry) => entry.aspect)).toContain('voice');
  });

  it('sends a seed when asked, because this API documents one', async () => {
    const body = await bodySentFor();
    expect(body).not.toHaveProperty('seed');

    const stub = stubbed();
    await build(stub).synthesizeSpeech({
      text: 'او رفت.',
      voice: voice(),
      direction: direction(),
      language: 'fa',
      seed: 99,
    });
    expect((stub.requests[0]?.json as { seed: number }).seed).toBe(99);
  });

  it('names the media type from the configured output format', async () => {
    for (const [format, mime] of [
      ['pcm_24000', 'audio/pcm'],
      ['opus_48000_128', 'audio/opus'],
      ['ulaw_8000', 'audio/basic'],
      ['something_new', 'application/octet-stream'],
    ] as const) {
      const stub = stubbed();
      const outcome = await build(stub, { outputFormat: format }).synthesizeSpeech({
        text: 'او رفت.',
        voice: voice(),
        direction: direction(),
        language: 'fa',
      });
      expect(isOk(outcome)).toBe(true);
      if (isOk(outcome)) expect(outcome.value.audio.mimeType).toBe(mime);
    }
  });

  it('falls back to the normalised alignment when the plain one is absent', async () => {
    const body = elevenlabs.speech('abc');
    delete body.alignment;
    const stub = new FetchStub().on(ROUTE, { json: body });
    const outcome = await build(stub).synthesizeSpeech({
      text: 'abc',
      voice: voice(),
      direction: direction(),
      language: 'fa',
    });
    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) expect(outcome.value.audio.durationMs).toBe(180);
  });

  it('returns no alignment when neither form is present', async () => {
    const stub = new FetchStub().on(ROUTE, {
      json: { audio_base64: (elevenlabs.speech('a') as { audio_base64: string }).audio_base64 },
    });
    const outcome = await build(stub).synthesizeSpeech({
      text: 'a',
      voice: voice(),
      direction: direction(),
      language: 'fa',
    });
    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) expect(outcome.value.alignment).toBeNull();
  });

  it('returns no alignment when the character list is empty', async () => {
    const body = elevenlabs.speech('');
    const stub = new FetchStub().on(ROUTE, { json: body });
    const outcome = await build(stub).synthesizeSpeech({
      text: 'a',
      voice: voice(),
      direction: direction(),
      language: 'fa',
    });
    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) expect(outcome.value.alignment).toBeNull();
  });

  it('falls back to a permissive declaration for a model the catalogue has never seen', () => {
    const adapter = build(new FetchStub(), { model: 'eleven_v4' });
    expect(adapter.speech.languages).toEqual([]);
    expect(adapter.speech.returnsAlignment).toBe(true);
  });
});
