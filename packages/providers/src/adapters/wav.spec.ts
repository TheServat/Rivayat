/**
 * The WAV reader, against a file a real engine really produced.
 *
 * `chatterbox-take.wav` is half a second cut from an actual Chatterbox generation run on
 * this machine (2026-08-24, `exaggeration 0.5 / cfg_weight 0.5`, 24 kHz). That matters:
 * a parser tested only against headers the test itself wrote is a parser tested against
 * its own assumptions, and the assumption that bites - that `fmt ` is at offset 12 and
 * `data` at 36 - is exactly the one a synthetic fixture would never falsify.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readWavFacts, wavDurationMs } from './wav';

const REAL_TAKE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./__fixtures__/chatterbox-take.wav', import.meta.url))),
);

/** Builds a WAV with an arbitrary list of chunks between the header and the data. */
function wav(options: {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly dataBytes: number;
  readonly extraChunks?: readonly { id: string; body: Uint8Array }[];
  readonly declaredDataSize?: number;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  const ascii = (text: string): Uint8Array =>
    Uint8Array.from([...text].map((character) => character.charCodeAt(0)));
  const u32 = (value: number): Uint8Array =>
    Uint8Array.from([
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
      (value >> 24) & 0xff,
    ]);
  const u16 = (value: number): Uint8Array => Uint8Array.from([value & 0xff, (value >> 8) & 0xff]);

  const byteRate = (options.sampleRate * options.channels * options.bitsPerSample) / 8;
  const fmt = new Uint8Array([
    ...u16(1),
    ...u16(options.channels),
    ...u32(options.sampleRate),
    ...u32(byteRate),
    ...u16((options.channels * options.bitsPerSample) / 8),
    ...u16(options.bitsPerSample),
  ]);

  parts.push(ascii('RIFF'), u32(0), ascii('WAVE'));
  parts.push(ascii('fmt '), u32(fmt.length), fmt);
  for (const chunk of options.extraChunks ?? []) {
    parts.push(ascii(chunk.id), u32(chunk.body.length), chunk.body);
    // RIFF requires a pad byte after an odd-length chunk, and a real encoder writes it.
    // Leaving it out here would have the fixture, not the parser, be the thing at fault.
    if (chunk.body.length % 2 === 1) parts.push(new Uint8Array(1));
  }
  parts.push(
    ascii('data'),
    u32(options.declaredDataSize ?? options.dataBytes),
    new Uint8Array(options.dataBytes),
  );

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('readWavFacts', () => {
  it('measures a file a real engine produced', () => {
    const facts = readWavFacts(REAL_TAKE);
    expect(facts).not.toBeNull();
    expect(facts?.sampleRateHz).toBe(24_000);
    expect(facts?.channels).toBe(1);
    expect(facts?.bitsPerSample).toBe(16);
    // The clip was cut to exactly 12000 samples at 24 kHz.
    expect(facts?.durationMs).toBe(500);
  });

  it('finds the data chunk past chunks an encoder inserted', () => {
    // The failure a fixed-offset reader has and never reports: a LIST chunk shifts
    // `data` and the duration comes out wrong by the weight of the metadata.
    const withMetadata = wav({
      sampleRate: 24_000,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: 48_000,
      extraChunks: [{ id: 'LIST', body: new Uint8Array(64) }],
    });
    expect(wavDurationMs(withMetadata)).toBe(1000);
  });

  it('tolerates the pad byte after an odd-length chunk', () => {
    const oddChunk = wav({
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: 16_000,
      extraChunks: [{ id: 'cue ', body: new Uint8Array(7) }],
    });
    expect(wavDurationMs(oddChunk)).toBe(1000);
  });

  it('trusts what is on disk when the declared data size is a streaming placeholder', () => {
    // A streamed WAV writes 0xFFFFFFFF for a length it did not know yet. Believing it
    // would report a duration of about thirteen hours.
    const streamed = wav({
      sampleRate: 24_000,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: 24_000,
      declaredDataSize: 0xffffffff,
    });
    expect(wavDurationMs(streamed)).toBe(500);
  });

  it('returns null rather than a plausible number for anything it cannot read', () => {
    expect(readWavFacts(new Uint8Array(0))).toBeNull();
    expect(readWavFacts(Uint8Array.from([0x49, 0x44, 0x33, 0x04]))).toBeNull();
    // RIFF, but not WAVE.
    const notWave = new Uint8Array(REAL_TAKE.slice(0, 64));
    notWave.set(Uint8Array.from([0x41, 0x56, 0x49, 0x20]), 8);
    expect(readWavFacts(notWave)).toBeNull();
  });

  it('returns null for a WAVE with no data chunk at all', () => {
    const headerOnly = REAL_TAKE.slice(0, 36);
    expect(wavDurationMs(headerOnly)).toBeNull();
  });

  it('returns null when the fmt chunk declares a zero sample rate', () => {
    const zeroRate = wav({
      sampleRate: 0,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: 1024,
    });
    expect(readWavFacts(zeroRate)).toBeNull();
  });

  it('stops rather than looping when a chunk declares a zero length', () => {
    const zeroChunk = wav({
      sampleRate: 24_000,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: 2400,
      extraChunks: [{ id: 'junk', body: new Uint8Array(0) }],
    });
    // The zero-length chunk ends the walk before `data`, so there is nothing to measure -
    // which is the honest answer, and infinitely better than spinning.
    expect(readWavFacts(zeroChunk)).toBeNull();
  });
});
