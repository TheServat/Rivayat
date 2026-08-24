/**
 * Chatterbox: the language refusal, and the scalar that has to carry everything.
 *
 * The most important test in this file is the first one. Persian is the series language
 * and these weights do not have it; sending it anyway produces fluent, confident,
 * wrong-language audio that passes every automated check downstream. So the refusal is
 * asserted at the level that matters - **zero requests sent** - rather than by inspecting
 * an error message.
 *
 * The parameter pairs asserted below were generated for real on this machine on
 * 2026-08-24 (see `docs/00-research.md` §9): at `exaggeration 0.5 / cfg 0.5` the line
 * came back 3.16 s, at `0.7 / 0.3` 3.00 s, at `0.3 / 0.5` 3.60 s. That is the vendor's
 * documented claim - higher exaggeration speeds speech up - reproduced, which is the
 * evidence `cfgWeightFor` is built on.
 */

import { describe, expect, it } from 'vitest';
import type { SpeechCapabilities, SpeechDirection, VoiceProfile } from '@rv/contracts';
import { CHATTERBOX_MULTILINGUAL_LANGUAGES } from '@rv/contracts';
import { isErr, isOk } from '@rv/shared-kernel';

import { FetchStub } from '../../__fixtures__/fetch-stub';
import { wavBytes } from '../../__fixtures__/responses';
import { fixedClock } from '../../__fixtures__/support';
import {
  CHATTERBOX_DRAMATIC,
  CHATTERBOX_NEUTRAL,
  ChatterboxAdapter,
  cfgWeightFor,
} from './chatterbox-adapter';

const SPEAKER = `ent_${'0'.repeat(24)}A1`;

function voice(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    role: 'character',
    performedBy: 'synthetic',
    speakerRef: SPEAKER,
    label: 'Kael',
    language: 'en',
    binding: { presetId: 'kael', exemplar: null },
    pitchBias: 0,
    tempoBias: 0,
    expressiveness: 0.5,
    rationale: 'expansive, warm, talks around a thing before he says it',
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

function persianWeights(): SpeechCapabilities {
  return {
    emotionControl: 'scalar',
    clonesFromExemplar: true,
    selectsPresetVoice: true,
    acceptsSeed: true,
    returnsAlignment: false,
    languages: ['fa'],
    maxCharactersPerRequest: null,
    sampleRateHz: 24_000,
    watermarks: true,
  };
}

describe('ChatterboxAdapter language declaration', () => {
  it('refuses Persian on the stock multilingual weights, sending nothing', async () => {
    const stub = new FetchStub().on('/tts', { bytes: wavBytes() });
    const adapter = new ChatterboxAdapter({ fetch: stub.fetch, clock: fixedClock() });

    expect(CHATTERBOX_MULTILINGUAL_LANGUAGES).not.toContain('fa');

    const outcome = await adapter.synthesizeSpeech({
      text: 'شب که می‌شود فانوس را روشن می‌کند.',
      voice: voice({ language: 'fa' }),
      direction: direction(),
      language: 'fa',
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(outcome.error.retryable).toBe(false);
    }
    // The property under test: no fluent nonsense was generated and nothing was spent.
    expect(stub.requests).toHaveLength(0);
  });

  it('serves Persian when the deployment declares weights that have it', async () => {
    const stub = new FetchStub().on('/tts', { bytes: wavBytes() });
    const adapter = new ChatterboxAdapter({
      fetch: stub.fetch,
      clock: fixedClock(),
      model: 'community/chatterbox-persian',
      speech: persianWeights(),
    });

    const outcome = await adapter.synthesizeSpeech({
      text: 'شب که می‌شود فانوس را روشن می‌کند.',
      voice: voice({ language: 'fa' }),
      direction: direction(),
      language: 'fa',
    });

    expect(isOk(outcome)).toBe(true);
    expect((stub.requests[0]?.json as { language: string }).language).toBe('fa');
  });

  it('serves a language the stock weights really do have', async () => {
    const stub = new FetchStub().on('/tts', { bytes: wavBytes() });
    const adapter = new ChatterboxAdapter({ fetch: stub.fetch, clock: fixedClock() });
    const outcome = await adapter.synthesizeSpeech({
      text: 'She lights the lamp.',
      voice: voice(),
      direction: direction(),
      language: 'en-GB',
    });
    expect(isOk(outcome)).toBe(true);
    // The engine takes a bare ISO-639-1 code; a region subtag would be rejected.
    expect((stub.requests[0]?.json as { language: string }).language).toBe('en');
  });
});

describe('cfgWeightFor follows the vendor line and stops at its ends', () => {
  it('reproduces both published anchors exactly', () => {
    expect(cfgWeightFor(CHATTERBOX_NEUTRAL.exaggeration)).toBe(CHATTERBOX_NEUTRAL.cfgWeight);
    expect(cfgWeightFor(CHATTERBOX_DRAMATIC.exaggeration)).toBe(CHATTERBOX_DRAMATIC.cfgWeight);
  });

  it('moves cfg down as exaggeration goes up, which is the documented relationship', () => {
    expect(cfgWeightFor(0.6)).toBeLessThan(cfgWeightFor(0.5));
    expect(cfgWeightFor(0.6)).toBeGreaterThan(cfgWeightFor(0.7));
  });

  it('clamps beyond the anchors rather than extrapolating past what was published', () => {
    expect(cfgWeightFor(0.1)).toBe(CHATTERBOX_NEUTRAL.cfgWeight);
    expect(cfgWeightFor(1)).toBe(CHATTERBOX_DRAMATIC.cfgWeight);
  });
});

describe('ChatterboxAdapter translation', () => {
  function build(stub: FetchStub): ChatterboxAdapter {
    return new ChatterboxAdapter({ fetch: stub.fetch, clock: fixedClock() });
  }

  async function send(
    stub: FetchStub,
    overrides: { direction?: SpeechDirection; voice?: VoiceProfile; seed?: number } = {},
  ): Promise<Record<string, unknown>> {
    await build(stub).synthesizeSpeech({
      text: 'She lights the lamp.',
      voice: overrides.voice ?? voice(),
      direction: overrides.direction ?? direction(),
      language: 'en',
      ...(overrides.seed === undefined ? {} : { seed: overrides.seed }),
    });
    return (stub.requests[0]?.json ?? {}) as Record<string, unknown>;
  }

  it('pushes a high-arousal line further up the scalar than a still one', async () => {
    const angry = await send(new FetchStub().on('/tts', { bytes: wavBytes() }), {
      direction: direction({ emotion: 'anger', intensity: 0.9 }),
    });
    const settled = await send(new FetchStub().on('/tts', { bytes: wavBytes() }), {
      direction: direction({ emotion: 'contentment', intensity: 0.2 }),
    });
    expect(angry.exaggeration).toBeGreaterThan(Number(settled.exaggeration));
    // And the counterweight moves the other way, as the vendor guidance says it should.
    expect(angry.cfg_weight).toBeLessThanOrEqual(Number(settled.cfg_weight));
  });

  it('reports the emotion as approximated, not dropped: its arousal really did get through', async () => {
    const stub = new FetchStub().on('/tts', { bytes: wavBytes() });
    const outcome = await build(stub).synthesizeSpeech({
      text: 'She lights the lamp.',
      voice: voice(),
      direction: direction({ emotion: 'bitterness', intensity: 0.7 }),
      language: 'en',
    });

    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    const gap = outcome.value.rendered.approximated.find((entry) => entry.aspect === 'emotion');
    expect(gap?.requested).toBe('bitterness');
    expect(gap?.substituted).toMatch(/^exaggeration=/u);
    expect(outcome.value.rendered.dropped.map((entry) => entry.aspect)).not.toContain('emotion');
  });

  it('drops volume, irony and pitch, because there is no channel for any of them', async () => {
    const stub = new FetchStub().on('/tts', { bytes: wavBytes() });
    const outcome = await build(stub).synthesizeSpeech({
      text: 'She lights the lamp.',
      voice: voice({ pitchBias: -0.8 }),
      direction: direction({ volume: 'shout', stance: 'ironic' }),
      language: 'en',
    });

    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    const dropped = outcome.value.rendered.dropped.map((entry) => entry.aspect).sort();
    expect(dropped).toEqual(['stance', 'voice', 'volume']);
  });

  it('damps a concealing line, because the shared expressiveness rule says so', async () => {
    const open = await send(new FetchStub().on('/tts', { bytes: wavBytes() }), {
      direction: direction({ emotion: 'anxiety', intensity: 0.8 }),
    });
    const held = await send(new FetchStub().on('/tts', { bytes: wavBytes() }), {
      direction: direction({ emotion: 'anxiety', intensity: 0.8, stance: 'concealing' }),
    });
    expect(held.exaggeration).toBeLessThan(Number(open.exaggeration));
  });

  it('lets the voice profile separate two characters given the same direction', async () => {
    const flat = await send(new FetchStub().on('/tts', { bytes: wavBytes() }), {
      voice: voice({ expressiveness: 0.1 }),
      direction: direction({ emotion: 'joy', intensity: 0.6 }),
    });
    const theatrical = await send(new FetchStub().on('/tts', { bytes: wavBytes() }), {
      voice: voice({ expressiveness: 0.9 }),
      direction: direction({ emotion: 'joy', intensity: 0.6 }),
    });
    expect(theatrical.exaggeration).toBeGreaterThan(Number(flat.exaggeration));
  });

  it('keeps speed_factor inside the documented bounds even at the extremes', async () => {
    const rushed = await send(new FetchStub().on('/tts', { bytes: wavBytes() }), {
      voice: voice({ tempoBias: 1 }),
      direction: direction({ pace: 'rushed' }),
    });
    const slow = await send(new FetchStub().on('/tts', { bytes: wavBytes() }), {
      voice: voice({ tempoBias: -1 }),
      direction: direction({ pace: 'slow' }),
    });
    expect(Number(rushed.speed_factor)).toBeLessThanOrEqual(2);
    expect(Number(slow.speed_factor)).toBeGreaterThanOrEqual(0.5);
    expect(Number(rushed.speed_factor)).toBeGreaterThan(Number(slow.speed_factor));
  });

  it('passes a seed through, because this engine actually has one', async () => {
    const body = await send(new FetchStub().on('/tts', { bytes: wavBytes() }), { seed: 42 });
    expect(body.seed).toBe(42);
  });

  it('clones from a filename in the server sandbox, or selects a predefined voice', async () => {
    const cloning = new FetchStub().on('/tts', { bytes: wavBytes() });
    await build(cloning).synthesizeSpeech({
      text: 'She lights the lamp.',
      voice: voice(),
      direction: direction(),
      language: 'en',
      exemplarUri: 'kael-reference.wav',
    });
    expect(cloning.requests[0]?.json).toMatchObject({
      voice_mode: 'clone',
      reference_audio_filename: 'kael-reference.wav',
    });

    const predefined = await send(new FetchStub().on('/tts', { bytes: wavBytes() }));
    expect(predefined).toMatchObject({ voice_mode: 'predefined', predefined_voice_id: 'kael' });
  });

  it('reports an unbound voice instead of pretending the default was the character', async () => {
    const stub = new FetchStub().on('/tts', { bytes: wavBytes() });
    const outcome = await build(stub).synthesizeSpeech({
      text: 'She lights the lamp.',
      voice: voice({ binding: { presetId: null, exemplar: null } }),
      direction: direction(),
      language: 'en',
    });
    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.rendered.dropped.map((entry) => entry.aspect)).toContain('voice');
  });

  it('quotes free and counts the characters, because the free lane still has to be visible', () => {
    const quote = new ChatterboxAdapter({ clock: fixedClock() }).quoteSpeech({
      text: 'She lights the lamp.',
    });
    expect(quote.kind).toBe('free');
    expect(quote.characters).toBe('She lights the lamp.'.length);
    if (quote.kind === 'free') expect(quote.nanoUsd).toBe(0);
  });

  it('measures the take from the WAV it was sent', async () => {
    const stub = new FetchStub().on('/tts', { bytes: wavBytes(48_000) });
    const outcome = await build(stub).synthesizeSpeech({
      text: 'She lights the lamp.',
      voice: voice(),
      direction: direction(),
      language: 'en',
    });
    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.audio.durationMs).toBe(2000);
    expect(outcome.value.usage.speech).toEqual({
      characters: 'She lights the lamp.'.length,
      audioMs: 2000,
    });
  });

  it('treats an empty body as a retryable provider failure', async () => {
    const stub = new FetchStub().on('/tts', { bytes: new Uint8Array(0) });
    const outcome = await build(stub).synthesizeSpeech({
      text: 'She lights the lamp.',
      voice: voice(),
      direction: direction(),
      language: 'en',
    });
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.retryable).toBe(true);
  });

  it('sends the deployment knobs only when they were set', async () => {
    const bare = await send(new FetchStub().on('/tts', { bytes: wavBytes() }));
    expect(bare).not.toHaveProperty('temperature');
    expect(bare).not.toHaveProperty('split_text');

    const tuned = new FetchStub().on('/tts', { bytes: wavBytes() });
    await new ChatterboxAdapter({
      fetch: tuned.fetch,
      clock: fixedClock(),
      temperature: 0.8,
      splitText: false,
    }).synthesizeSpeech({
      text: 'She lights the lamp.',
      voice: voice(),
      direction: direction(),
      language: 'en',
    });
    expect(tuned.requests[0]?.json).toMatchObject({ temperature: 0.8, split_text: false });
  });

  it('falls back to a permissive declaration for weights the catalogue has never seen', () => {
    const adapter = new ChatterboxAdapter({ model: 'someone/a-finetune', clock: fixedClock() });
    expect(adapter.speech.languages).toEqual([]);
    expect(adapter.speech.watermarks).toBe(true);
  });
});
