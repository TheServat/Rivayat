import { describe, expect, it } from 'vitest';
import { isErr } from '@rv/shared-kernel';

import { FakeStructuredBackend, respondError, respondJson } from '../__fixtures__/fakes';
import { testDeps } from '../__fixtures__/builders';
import {
  CompressSourceUseCase,
  DEFAULT_CHUNK_OPTIONS,
  chunkSource,
  renderDigests,
} from './compress';

function digest(ordinal: number): Record<string, unknown> {
  return {
    synopsis: `Passage ${String(ordinal)} synopsis.`,
    events: [`Event in passage ${String(ordinal)}.`],
    charactersSeen: ['Mahtab'],
    placesSeen: ['The lamp room'],
    promisesPlanted: [],
    promisesPaid: [],
    droppedNote: `The weather digressions of passage ${String(ordinal)}.`,
  };
}

function longSource(chars: number): string {
  const paragraph = 'She went up the stair and the salt came with her, as it always did. ';
  const repeats = Math.ceil(chars / (paragraph.length + 2));
  return Array.from({ length: repeats }, () => paragraph).join('\n\n');
}

describe('chunkSource', () => {
  it('produces one chunk for a document that fits the window', () => {
    const chunks = chunkSource('a short document');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.ordinal).toBe(1);
    expect(chunks[0]?.startChar).toBe(0);
  });

  it('is deterministic - the same document always cuts the same way', () => {
    const source = longSource(40_000);
    expect(chunkSource(source, { windowChars: 5_000 })).toEqual(
      chunkSource(source, { windowChars: 5_000 }),
    );
  });

  it('numbers the windows contiguously and covers the end of the document', () => {
    const source = longSource(40_000);
    const chunks = chunkSource(source, { windowChars: 5_000 });
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index + 1));
    // The last window reaches the last characters of the source - the whole point.
    const tail = chunks[chunks.length - 1]?.text.slice(-40) ?? 'nope';
    expect(source.trimEnd().endsWith(tail)).toBe(true);
  });

  it('overlaps consecutive windows so a scene across a cut is not halved', () => {
    const source = longSource(20_000);
    const chunks = chunkSource(source, { windowChars: 4_000, overlapChars: 400 });
    const first = chunks[0];
    const second = chunks[1];
    if (first === undefined || second === undefined) throw new Error('expected two windows');
    expect(second.startChar).toBeLessThan(first.startChar + 4_000);
  });

  it('makes progress even when asked for an overlap as wide as the window', () => {
    const chunks = chunkSource(longSource(6_000), { windowChars: 1_000, overlapChars: 10_000 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(100);
  });

  it('drops a window that is only whitespace', () => {
    const chunks = chunkSource(`start${'\n'.repeat(2_000)}end`, { windowChars: 500 });
    expect(chunks.every((chunk) => chunk.text.trim() !== '')).toBe(true);
  });

  it('has a documented default window', () => {
    expect(DEFAULT_CHUNK_OPTIONS.windowChars).toBeGreaterThan(1_000);
    expect(DEFAULT_CHUNK_OPTIONS.overlapChars).toBeGreaterThan(0);
  });
});

describe('CompressSourceUseCase', () => {
  it('passes a short source through untouched and calls nothing', async () => {
    const backend = new FakeStructuredBackend();
    const outcome = await new CompressSourceUseCase(testDeps(backend)).execute({
      source: 'A short story about a lighthouse.',
      sourceLabel: 'prose work',
      language: 'en',
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.strategy).toBe('verbatim');
    expect(outcome.value.material).toBe('A short story about a lighthouse.');
    expect(outcome.value.report.ratio).toBe(1);
    expect(backend.callCount).toBe(0);
  });

  it('digests a single oversized window as one pass', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(digest(1))] });
    const outcome = await new CompressSourceUseCase(testDeps(backend)).execute({
      source: longSource(3_000),
      sourceLabel: 'prose work',
      language: 'en',
      tokenCeiling: 100,
      window: { windowChars: 100_000 },
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.strategy).toBe('single-pass');
    expect(outcome.value.digests).toHaveLength(1);
    expect(backend.callCount).toBe(1);
  });

  it('carries the previous synopsis into the next window - the recurrent state', async () => {
    const source = longSource(12_000);
    const chunks = chunkSource(source, { windowChars: 4_000 });
    const backend = new FakeStructuredBackend({
      script: chunks.map((chunk) => respondJson(digest(chunk.ordinal))),
    });
    const outcome = await new CompressSourceUseCase(testDeps(backend)).execute({
      source,
      sourceLabel: 'prose work',
      language: 'en',
      tokenCeiling: 100,
      window: { windowChars: 4_000 },
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.strategy).toBe('chunked-digest');
    expect(backend.userPromptAt(0)).toContain('Nothing - this is the opening passage.');
    expect(backend.userPromptAt(1)).toContain('Passage 1 synopsis.');
    expect(backend.userPromptAt(2)).toContain('Passage 2 synopsis.');
  });

  it('reports what was dropped rather than claiming nothing was', async () => {
    const source = longSource(9_000);
    const chunks = chunkSource(source, { windowChars: 4_000 });
    const backend = new FakeStructuredBackend({
      script: chunks.map((chunk) => respondJson(digest(chunk.ordinal))),
    });
    const outcome = await new CompressSourceUseCase(testDeps(backend)).execute({
      source,
      sourceLabel: 'prose work',
      language: 'en',
      tokenCeiling: 100,
      window: { windowChars: 4_000 },
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.report.note).toContain('weather digressions');
    expect(outcome.value.report.sourceChars).toBe(source.trim().length);
    expect(outcome.value.report.ratio).toBeGreaterThan(1);
  });

  it('stops at the first window it cannot digest', async () => {
    const backend = new FakeStructuredBackend({ script: [respondError(), respondError()] });
    const outcome = await new CompressSourceUseCase(testDeps(backend)).execute({
      source: longSource(9_000),
      sourceLabel: 'prose work',
      language: 'en',
      tokenCeiling: 100,
      window: { windowChars: 4_000 },
    });
    expect(isErr(outcome)).toBe(true);
  });
});

describe('renderDigests', () => {
  it('lays the digests out in order with their four question headings', () => {
    const rendered = renderDigests([
      {
        synopsis: 'One.',
        events: ['A thing happened.'],
        charactersSeen: ['Mahtab'],
        placesSeen: ['The quay'],
        promisesPlanted: ['Someone is lying.'],
        promisesPaid: [],
        droppedNote: 'The weather.',
      },
    ]);

    expect(rendered).toContain('### Passage 1');
    expect(rendered).toContain('A thing happened.');
    expect(rendered).toContain('Someone is lying.');
    expect(rendered).toContain('## Paid off\nnothing');
    expect(rendered).toContain('The weather.');
  });
});
