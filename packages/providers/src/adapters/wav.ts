/**
 * Reading a WAV header, so a cue's length is measured rather than guessed.
 *
 * The audio timeline refuses a guessed duration on purpose: a cue whose length is wrong
 * mistimes every cue after it, and the narrator then reads to a video that has drifted.
 * A RIFF header states the length exactly and costs nothing to parse, so for the two
 * engines that return WAV there is no reason to be uncertain.
 *
 * Everything here returns `null` on anything it does not understand. That is the whole
 * design: a parser that returned a plausible number for a truncated file, or for an MP3,
 * would be worse than one that admits it cannot tell - the caller has other ways to find
 * out (an engine's own alignment, or a decode) and no way to detect a confident lie.
 */

/** ASCII, because every RIFF chunk id is. Avoids a TextDecoder for four bytes. */
function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return out;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  );
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

/** What a WAV header states about itself. `null` for anything that is not a readable WAV. */
export interface WavFacts {
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly durationMs: number;
}

const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

/**
 * Reads the sample rate and the length out of a RIFF/WAVE header.
 *
 * Walks the chunk list rather than assuming `fmt ` sits at offset 12 and `data` at 36.
 * That assumption holds for a canonical 44-byte header and fails for every file a real
 * encoder writes, because encoders insert `LIST`, `fact` and `cue ` chunks freely - and
 * the failure is silent, producing a duration off by whatever the extra chunks weigh.
 */
export function readWavFacts(bytes: Uint8Array): WavFacts | null {
  if (bytes.length < HEADER_BYTES) return null;
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') return null;

  let sampleRateHz = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let byteRate = 0;
  let dataBytes = -1;

  let cursor = HEADER_BYTES;
  while (cursor + CHUNK_HEADER_BYTES <= bytes.length) {
    const id = readAscii(bytes, cursor, 4);
    const size = readU32(bytes, cursor + 4);
    const body = cursor + CHUNK_HEADER_BYTES;

    if (id === 'fmt ' && body + 16 <= bytes.length) {
      channels = readU16(bytes, body + 2);
      sampleRateHz = readU32(bytes, body + 4);
      byteRate = readU32(bytes, body + 8);
      bitsPerSample = readU16(bytes, body + 14);
    } else if (id === 'data') {
      // A streamed WAV writes 0xFFFFFFFF or 0 for a length it did not know yet. What is
      // really on disk is what is left of the buffer, and that is the honest answer.
      const declared = size;
      const available = bytes.length - body;
      dataBytes = declared > 0 && declared <= available ? declared : available;
      break;
    }

    // Chunks are word-aligned: an odd size is followed by one pad byte.
    cursor = body + size + (size % 2);
    if (size <= 0) break;
  }

  if (sampleRateHz <= 0 || byteRate <= 0 || dataBytes < 0) return null;

  return {
    sampleRateHz,
    channels,
    bitsPerSample,
    durationMs: Math.round((dataBytes / byteRate) * 1000),
  };
}

/** Length of a WAV in milliseconds, or `null` when the bytes are not a readable WAV. */
export function wavDurationMs(bytes: Uint8Array): number | null {
  return readWavFacts(bytes)?.durationMs ?? null;
}
