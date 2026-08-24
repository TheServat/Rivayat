/**
 * Higgs: the tag translation, the two dialects, and the honesty of the gap report.
 *
 * The assertions that matter here are not "it made a request". They are:
 *
 *  - every token emitted is one the model card lists, because a token it does not list
 *    is read aloud to the audience;
 *  - a direction the engine cannot express is *reported*, not silently swallowed;
 *  - `mistaken` adds nothing, which is the one rule in the whole audio layer that a
 *    reasonable person would implement backwards.
 */

import { describe, expect, it } from 'vitest';
import type { SpeechDirection, VoiceProfile } from '@rv/contracts';
import { isErr, isOk } from '@rv/shared-kernel';

import { FetchStub } from '../../__fixtures__/fetch-stub';
import { wavBytes } from '../../__fixtures__/responses';
import { fixedClock } from '../../__fixtures__/support';
import { HIGGS_EMOTIONS, HIGGS_PROSODY, HIGGS_STYLES, renderHiggsInput } from './tags';
import { HiggsAdapter } from './higgs-adapter';

const SPEAKER = `ent_${'0'.repeat(24)}A1`;

function voice(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    role: 'character',
    performedBy: 'synthetic',
    speakerRef: SPEAKER,
    label: 'Mahtab',
    language: 'fa',
    binding: { presetId: null, exemplar: null },
    pitchBias: 0,
    tempoBias: 0,
    expressiveness: 0.5,
    rationale: 'terse, formal, and goes quiet before she goes hard',
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

/** Every token the renderer can possibly emit, pulled back out of the rendered string. */
function tokensIn(text: string): string[] {
  return [...text.matchAll(/<\|([a-z]+):([a-z_]+)\|>/gu)].map(
    (match) => `${match[1] ?? ''}:${match[2] ?? ''}`,
  );
}

const KNOWN_TOKENS = new Set<string>([
  ...HIGGS_EMOTIONS.map((tag) => `emotion:${tag}`),
  ...HIGGS_STYLES.map((tag) => `style:${tag}`),
  ...HIGGS_PROSODY.map((tag) => `prosody:${tag}`),
]);

describe('renderHiggsInput emits only tokens the model card lists', () => {
  const bias = { pitchBias: 0, tempoBias: 0, expressiveness: 0.5 };

  it('never produces a token outside the verified catalogue, over the whole cross product', () => {
    const emotions = ['neutral', 'joy', 'anger', 'contempt', 'grief', 'resignation'] as const;
    const paces = ['slow', 'measured', 'quick', 'rushed'] as const;
    const volumes = ['whisper', 'low', 'normal', 'raised', 'shout'] as const;
    const stances = ['plain', 'mistaken', 'concealing', 'ironic'] as const;

    for (const emotion of emotions) {
      for (const pace of paces) {
        for (const volume of volumes) {
          for (const stance of stances) {
            for (const intensity of [0, 0.5, 1]) {
              const rendered = renderHiggsInput(
                'x',
                direction({ emotion, pace, volume, stance, intensity }),
                { ...bias, pitchBias: intensity - 0.5, tempoBias: intensity - 0.5 },
              );
              for (const token of tokensIn(rendered.text)) {
                expect(KNOWN_TOKENS.has(token), `${token} is not in the model card`).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it('puts every sentence-level tag before the first word, as the model card requires', () => {
    const rendered = renderHiggsInput(
      'برو.',
      direction({ emotion: 'anger', volume: 'shout', pace: 'quick', intensity: 0.9 }),
      bias,
    );
    const firstWord = rendered.text.indexOf('برو');
    const lastTag = rendered.text.lastIndexOf('|>');
    expect(lastTag).toBeLessThan(firstWord);
  });

  it('emits no emotion token for a neutral line, because an unmarked line is what neutral means', () => {
    const rendered = renderHiggsInput('باشد.', direction(), bias);
    expect(tokensIn(rendered.text).filter((token) => token.startsWith('emotion:'))).toEqual([]);
  });

  it('reports a lossy emotion as approximated rather than passing it off as exact', () => {
    const rendered = renderHiggsInput('نه.', direction({ emotion: 'contempt' }), bias);
    expect(rendered.applied).toContain('emotion:disgust');
    expect(rendered.approximated).toHaveLength(1);
    expect(rendered.approximated[0]?.aspect).toBe('emotion');
    expect(rendered.approximated[0]?.substituted).toBe('disgust');
  });

  it('drops a conversational level change instead of borrowing whisper or shout for it', () => {
    const rendered = renderHiggsInput('باشد.', direction({ volume: 'raised' }), bias);
    expect(rendered.dropped.map((gap) => gap.aspect)).toEqual(['volume']);
    expect(tokensIn(rendered.text).some((token) => token.startsWith('style:'))).toBe(false);
  });

  it('uses the style tags at the two ends it really has', () => {
    expect(tokensIn(renderHiggsInput('x', direction({ volume: 'whisper' }), bias).text)).toContain(
      'style:whispering',
    );
    expect(tokensIn(renderHiggsInput('x', direction({ volume: 'shout' }), bias).text)).toContain(
      'style:shouting',
    );
  });

  it('adds nothing at all for a sincerely mistaken line', () => {
    // The rule with the highest chance of being implemented backwards: the audience
    // holds the irony, so the voice must not signal it. A `mistaken` line and a `plain`
    // line at the same intensity are the same request.
    const plain = renderHiggsInput('او زنده است.', direction({ emotion: 'relief' }), bias);
    const mistaken = renderHiggsInput(
      'او زنده است.',
      direction({ emotion: 'relief', stance: 'mistaken' }),
      bias,
    );
    expect(mistaken.text).toBe(plain.text);
    expect(mistaken.applied).toEqual(plain.applied);
  });

  it('flattens a concealing line and says so', () => {
    const concealing = renderHiggsInput(
      'چیزی نیست.',
      direction({ emotion: 'anxiety', intensity: 0.9, stance: 'concealing' }),
      bias,
    );
    expect(concealing.applied).toContain('prosody:expressive_low');
  });

  it('reports irony as approximated, because Higgs has no wink', () => {
    const ironic = renderHiggsInput('عالی بود.', direction({ stance: 'ironic' }), bias);
    expect(ironic.approximated.map((gap) => gap.aspect)).toContain('stance');
  });

  it('lets the voice bias move the speed, so two characters do not read at one rate', () => {
    const fast = renderHiggsInput('x', direction({ pace: 'measured' }), { ...bias, tempoBias: 1 });
    const slow = renderHiggsInput('x', direction({ pace: 'measured' }), { ...bias, tempoBias: -1 });
    expect(fast.applied).toContain('prosody:speed_fast');
    expect(slow.applied).toContain('prosody:speed_slow');
  });

  it('maps a strong pitch bias to the two pitch tokens and nothing in between', () => {
    expect(renderHiggsInput('x', direction(), { ...bias, pitchBias: 1 }).applied).toContain(
      'prosody:pitch_high',
    );
    expect(renderHiggsInput('x', direction(), { ...bias, pitchBias: -1 }).applied).toContain(
      'prosody:pitch_low',
    );
    expect(
      renderHiggsInput('x', direction(), { ...bias, pitchBias: 0.2 }).applied.some((entry) =>
        entry.startsWith('prosody:pitch'),
      ),
    ).toBe(false);
  });

  it('clamps a speed beyond the four steps rather than emitting a token that does not exist', () => {
    const rendered = renderHiggsInput('x', direction({ pace: 'rushed' }), {
      ...bias,
      tempoBias: 1,
    });
    expect(rendered.applied).toContain('prosody:speed_very_fast');
  });
});

describe('HiggsAdapter', () => {
  function build(stub: FetchStub, options = {}): HiggsAdapter {
    return new HiggsAdapter({ fetch: stub.fetch, clock: fixedClock(), ...options });
  }

  it('refuses a language these weights do not declare, before opening a socket', async () => {
    const stub = new FetchStub().on('/v1/audio/speech', { bytes: wavBytes() });
    const adapter = build(stub, {
      speech: {
        emotionControl: 'named-tags',
        clonesFromExemplar: true,
        selectsPresetVoice: false,
        acceptsSeed: false,
        returnsAlignment: false,
        languages: ['en'],
        maxCharactersPerRequest: null,
        sampleRateHz: 24_000,
        watermarks: false,
      },
    });

    const outcome = await adapter.synthesizeSpeech({
      text: 'سلام',
      voice: voice(),
      direction: direction(),
      language: 'fa',
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(stub.requests).toHaveLength(0);
  });

  it('sends the tagged text and measures the take from its own header', async () => {
    const stub = new FetchStub().on('/v1/audio/speech', { bytes: wavBytes(24_000) });
    const adapter = build(stub);

    const outcome = await adapter.synthesizeSpeech({
      text: 'او رفت.',
      voice: voice(),
      direction: direction({ emotion: 'grief', intensity: 0.8 }),
      language: 'fa',
    });

    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    const sent = stub.requests[0]?.json as { input: string };
    expect(sent.input).toContain('<|emotion:sadness|>');
    expect(sent.input.endsWith('او رفت.')).toBe(true);
    // 24000 samples at 24 kHz mono 16-bit is exactly one second.
    expect(outcome.value.audio.durationMs).toBe(1000);
    expect(outcome.value.audio.sampleRateHz).toBe(24_000);
    expect(outcome.value.usage.speech?.characters).toBe(sent.input.length);
    // No timing is documented, so none is invented.
    expect(outcome.value.alignment).toBeNull();
  });

  it('reports a seed as dropped rather than letting a caller believe a take is repeatable', async () => {
    const stub = new FetchStub().on('/v1/audio/speech', { bytes: wavBytes() });
    const outcome = await build(stub).synthesizeSpeech({
      text: 'باشد.',
      voice: voice(),
      direction: direction(),
      language: 'fa',
      seed: 7,
    });

    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.rendered.dropped.map((gap) => gap.aspect)).toContain('seed');
    expect(stub.requests[0]?.json).not.toHaveProperty('seed');
  });

  it('does not claim preset voices on a self-hosted server, and says why when one is asked for', async () => {
    const stub = new FetchStub().on('/v1/audio/speech', { bytes: wavBytes() });
    const adapter = build(stub);
    expect(adapter.speech.selectsPresetVoice).toBe(false);

    const outcome = await adapter.synthesizeSpeech({
      text: 'سلام',
      voice: voice({ binding: { presetId: 'jake', exemplar: null } }),
      direction: direction(),
      language: 'fa',
    });

    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.rendered.dropped.map((gap) => gap.aspect)).toContain('voice');
    expect(stub.requests[0]?.json).not.toHaveProperty('voice');
  });

  it('spells the reference clip the way each dialect documents it', async () => {
    const selfHosted = new FetchStub().on('/v1/audio/speech', { bytes: wavBytes() });
    await build(selfHosted).synthesizeSpeech({
      text: 'سلام',
      voice: voice(),
      direction: direction(),
      language: 'fa',
      exemplarUri: '/srv/voices/mahtab.wav',
    });
    expect(selfHosted.requests[0]?.json).toHaveProperty('references');

    const cloud = new FetchStub().on('/v1/audio/speech', { bytes: wavBytes() });
    await build(cloud, { dialect: 'boson-cloud' }).synthesizeSpeech({
      text: 'سلام',
      voice: voice(),
      direction: direction(),
      language: 'fa',
      exemplarAudio: { mimeType: 'audio/wav', data: wavBytes() },
    });
    const cloudBody = cloud.requests[0]?.json as { ref_audio: string };
    expect(cloudBody.ref_audio.startsWith('data:audio/wav;base64,')).toBe(true);
  });

  it('quotes a local call as free, and still counts the characters it would send', () => {
    const quote = new HiggsAdapter({ clock: fixedClock() }).quoteSpeech({
      text: 'یک خط.',
      direction: direction({ emotion: 'anger' }),
    });
    expect(quote.kind).toBe('free');
    // The emotion tag is part of what is sent, so it is part of what is counted.
    expect(quote.characters).toBeGreaterThan('یک خط.'.length);
  });

  it('treats an empty audio body as a retryable provider failure', async () => {
    const stub = new FetchStub().on('/v1/audio/speech', { bytes: new Uint8Array(0) });
    const outcome = await build(stub).synthesizeSpeech({
      text: 'سلام',
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

  it('refuses an empty line rather than paying for silence', async () => {
    const stub = new FetchStub().on('/v1/audio/speech', { bytes: wavBytes() });
    const outcome = await build(stub).synthesizeSpeech({
      text: '   ',
      voice: voice(),
      direction: direction(),
      language: 'fa',
    });
    expect(isErr(outcome)).toBe(true);
    expect(stub.requests).toHaveLength(0);
  });

  it('reports an unbound voice, on either dialect', async () => {
    const cloud = new FetchStub().on('/v1/audio/speech', { bytes: wavBytes() });
    const outcome = await build(cloud, { dialect: 'boson-cloud' }).synthesizeSpeech({
      text: 'سلام',
      voice: voice(),
      direction: direction(),
      language: 'fa',
    });
    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.rendered.dropped.map((gap) => gap.aspect)).toContain('voice');
  });

  it('uses a preset on the hosted dialect, where the field is documented', async () => {
    const cloud = new FetchStub().on('/v1/audio/speech', { bytes: wavBytes() });
    await build(cloud, { dialect: 'boson-cloud' }).synthesizeSpeech({
      text: 'سلام',
      voice: voice({ binding: { presetId: 'jake', exemplar: null } }),
      direction: direction(),
      language: 'fa',
    });
    expect((cloud.requests[0]?.json as { voice: string }).voice).toBe('jake');
  });

  it('passes a URI through as ref_audio on the hosted dialect when no bytes were resolved', async () => {
    const cloud = new FetchStub().on('/v1/audio/speech', { bytes: wavBytes() });
    await build(cloud, { dialect: 'boson-cloud' }).synthesizeSpeech({
      text: 'سلام',
      voice: voice(),
      direction: direction(),
      language: 'fa',
      exemplarUri: 'https://example.invalid/mahtab.wav',
    });
    expect((cloud.requests[0]?.json as { ref_audio: string }).ref_audio).toBe(
      'https://example.invalid/mahtab.wav',
    );
  });

  it('sends the sampling knobs only when the deployment set them', async () => {
    const bare = new FetchStub().on('/v1/audio/speech', { bytes: wavBytes() });
    await build(bare).synthesizeSpeech({
      text: 'سلام',
      voice: voice(),
      direction: direction(),
      language: 'fa',
    });
    expect(bare.requests[0]?.json).not.toHaveProperty('temperature');

    const tuned = new FetchStub().on('/v1/audio/speech', { bytes: wavBytes() });
    await build(tuned, { temperature: 0.8, maxNewTokens: 1024 }).synthesizeSpeech({
      text: 'سلام',
      voice: voice(),
      direction: direction(),
      language: 'fa',
    });
    expect(tuned.requests[0]?.json).toMatchObject({ temperature: 0.8, max_new_tokens: 1024 });
  });

  it('falls back to a permissive declaration for a checkpoint the catalogue has never seen', () => {
    const adapter = new HiggsAdapter({ model: 'someone/a-persian-finetune', clock: fixedClock() });
    // Empty means unverified, and unverified must not mean unroutable.
    expect(adapter.speech.languages).toEqual([]);
    expect(adapter.quoteSpeech({ text: 'x' }).kind).toBe('unpriced');
  });

  it('quotes the raw text when no direction is supplied', () => {
    const quote = new HiggsAdapter({ clock: fixedClock() }).quoteSpeech({ text: 'abcde' });
    expect(quote.characters).toBe(5);
  });
});
