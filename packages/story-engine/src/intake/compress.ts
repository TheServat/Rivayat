/**
 * Narrative compression - the thing `Novel2Video` is actually doing (prior-art §A).
 *
 * A novel does not fit in a context window, and the interesting question is not how to
 * make it fit but **what survives**. Truncation answers "the first 30 000 characters",
 * which is the one answer that is always wrong: it throws away the ending.
 *
 * So the source is cut into overlapping windows, each window is digested into the things
 * a story planner needs - what happened, who was there, what was promised, what was paid
 * - and each digest is written with the previous digest's synopsis in front of it. That
 * carry-over is `RecurrentGPT`'s recurrent state (prior-art §B): chunk seven is not
 * summarised in isolation, it is summarised by something that knows how the book got
 * there. The digests, not the prose, are what the normalisation call reads.
 *
 * The windows are walked **in order and sequentially**. Parallelising them would be
 * faster and would break the carry-over, which is the only thing that distinguishes this
 * from a bag of independent summaries.
 */

import { z } from 'zod';
import { Label, type Locale, Prose } from '@rv/contracts';
import { PromptTemplate, type StructuredTrace, composePrompt, section } from '@rv/prompt-kit';
import { type AppError, type Result, isErr, ok } from '@rv/shared-kernel';

import { PRODUCER } from '../roles/index';
import { bulletList, inlineList, orElse } from '../support/format';
import { type StoryEngineDeps, TraceLog, runRoleCall } from '../support/stage-call';
import type { CompressionReport, CompressionStrategy } from './normalised-brief';

// ── windowing ───────────────────────────────────────────────────────────────

export interface ChunkOptions {
  /** How much source one digest call reads. */
  readonly windowChars: number;
  /**
   * How far each window reaches back into the previous one.
   *
   * Not decoration: a scene that straddles a cut is otherwise digested twice as two half
   * scenes, and the join is exactly where a reveal gets lost.
   */
  readonly overlapChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { windowChars: 12_000, overlapChars: 400 };

export interface SourceChunk {
  readonly ordinal: number;
  readonly startChar: number;
  readonly text: string;
}

/**
 * Cuts a document into ordered, overlapping windows.
 *
 * Pure and deterministic - the same document always yields the same windows, which is
 * what makes a compressed intake replayable and cacheable. Cuts prefer a paragraph break
 * in the last 40 % of the window and fall back to a hard cut, because a hard cut
 * mid-sentence costs one sentence while hunting arbitrarily far for a break costs the
 * window size guarantee.
 */
export function chunkSource(source: string, options: Partial<ChunkOptions> = {}): SourceChunk[] {
  const windowChars = Math.max(1, options.windowChars ?? DEFAULT_CHUNK_OPTIONS.windowChars);
  const overlapChars = Math.min(
    Math.max(0, options.overlapChars ?? DEFAULT_CHUNK_OPTIONS.overlapChars),
    Math.floor(windowChars / 4),
  );

  const spans: { start: number; text: string }[] = [];
  let start = 0;
  while (start < source.length) {
    const hardEnd = Math.min(start + windowChars, source.length);
    let end = hardEnd;
    if (hardEnd < source.length) {
      const earliest = start + Math.floor(windowChars * 0.6);
      const breakAt = source.lastIndexOf('\n\n', hardEnd);
      if (breakAt >= earliest) end = breakAt;
    }
    spans.push({ start, text: source.slice(start, end).trim() });
    if (end >= source.length) break;
    // `start + 1` is the progress guarantee: without it a window whose overlap equals its
    // width would reprocess the same span for ever.
    start = Math.max(end - overlapChars, start + 1);
  }

  return spans
    .filter((span) => span.text !== '')
    .map((span, index) => ({ ordinal: index + 1, startChar: span.start, text: span.text }));
}

// ── the digest ──────────────────────────────────────────────────────────────

/**
 * One window, compressed into the things a planner needs.
 *
 * Not a summary. A summary of chapter nine is prose a later call has to re-read; this is
 * already sorted into the four questions the story stage will ask - what changed, who was
 * in it, what was promised, what was kept.
 */
export const NarrativeDigest = z.strictObject({
  synopsis: Prose.describe(
    'What happens in this passage, in one paragraph, in the order it happens. Written so ' +
      'the next passage can be understood from it alone.',
  ),
  events: z
    .array(Prose)
    .min(1)
    .max(24)
    .describe(
      'The changes this passage makes to the world, one per entry, in order. Something ' +
        'that leaves nothing different is not an event.',
    ),
  charactersSeen: z
    .array(Label)
    .max(32)
    .default([])
    .describe('Everyone who appears or is named. Use the name the source uses.'),
  placesSeen: z.array(Label).max(24).default([]).describe('Where it happens.'),
  promisesPlanted: z
    .array(Prose)
    .max(12)
    .default([])
    .describe('What the passage makes the reader expect but does not deliver.'),
  promisesPaid: z
    .array(Prose)
    .max(12)
    .default([])
    .describe('Earlier expectations this passage delivers on.'),
  droppedNote: Prose.describe(
    'What you deliberately left out of the above and why. "Nothing" is not an answer for ' +
      'a passage of any length - say which texture, digression or minor thread went.',
  ),
});
export type NarrativeDigest = z.infer<typeof NarrativeDigest>;

const DIGEST_PROMPT = new PromptTemplate<{
  readonly sourceLabel: string;
  readonly language: string;
  readonly ordinal: number;
  readonly chunkCount: number;
  readonly carryOver: string;
  readonly passage: string;
}>(
  'intake.digest',
  [
    'Compress passage {{ordinal}} of {{chunkCount}} from a {{sourceLabel}} written in',
    '{{language}}.',
    '',
    'You are compressing, not reviewing. Keep names, causes and consequences; drop',
    'atmosphere, digression and anything that is texture rather than structure. Say what',
    'you dropped.',
    '',
    '## What happened before this passage',
    '{{carryOver}}',
    '',
    '## The passage',
    '{{passage}}',
  ].join('\n'),
);

// ── the use-case ────────────────────────────────────────────────────────────

export interface CompressSourceInput {
  readonly source: string;
  /** What kind of document this is, for the prompt: "screenplay", "novel excerpt". */
  readonly sourceLabel: string;
  readonly language: Locale;
  /**
   * How much material the *normalisation* call may read, in tokens.
   *
   * A ceiling rather than a target: a short story that already fits is passed through
   * verbatim, because compressing something that fits only loses information.
   */
  readonly tokenCeiling?: number;
  /** Characters per token. Crude on purpose - it decides a strategy, not a bill. */
  readonly charsPerToken?: number;
  readonly window?: Partial<ChunkOptions>;
  readonly signal?: AbortSignal;
}

export interface CompressedSource {
  readonly strategy: CompressionStrategy;
  /** What the normalisation call should read: the source itself, or the digests. */
  readonly material: string;
  readonly digests: readonly NarrativeDigest[];
  readonly report: CompressionReport;
  readonly traces: readonly StructuredTrace[];
}

export const DEFAULT_TOKEN_CEILING = 6_000;
export const DEFAULT_CHARS_PER_TOKEN = 4;

export class CompressSourceUseCase {
  readonly #deps: StoryEngineDeps;

  constructor(deps: StoryEngineDeps) {
    this.#deps = deps;
  }

  async execute(input: CompressSourceInput): Promise<Result<CompressedSource, AppError>> {
    const source = input.source.trim();
    const ceilingChars =
      (input.tokenCeiling ?? DEFAULT_TOKEN_CEILING) *
      (input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN);

    if (source.length <= ceilingChars) {
      return ok({
        strategy: 'verbatim',
        material: source,
        digests: [],
        report: {
          strategy: 'verbatim',
          sourceChars: source.length,
          chunkCount: 0,
          digestChars: source.length,
          ratio: 1,
          note: 'The source fits the intake budget; nothing was dropped.',
        },
        traces: [],
      });
    }

    const chunks = chunkSource(source, input.window ?? {});
    const traces = new TraceLog();
    const digests: NarrativeDigest[] = [];
    let carryOver = 'Nothing - this is the opening passage.';

    for (const chunk of chunks) {
      const outcome = await runRoleCall<NarrativeDigest>(this.#deps, {
        role: PRODUCER,
        schemaName: 'NarrativeDigest',
        schema: NarrativeDigest,
        user: DIGEST_PROMPT.render({
          sourceLabel: input.sourceLabel,
          language: input.language,
          ordinal: chunk.ordinal,
          chunkCount: chunks.length,
          carryOver,
          passage: chunk.text,
        }).text,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (isErr(outcome)) return outcome;

      traces.add(outcome.value.trace);
      digests.push(outcome.value.value);
      carryOver = outcome.value.value.synopsis;
    }

    const material = renderDigests(digests);
    const strategy: CompressionStrategy = chunks.length === 1 ? 'single-pass' : 'chunked-digest';

    return ok({
      strategy,
      material,
      digests,
      report: {
        strategy,
        sourceChars: source.length,
        chunkCount: chunks.length,
        digestChars: material.length,
        // Guarded: a digest longer than its source would make this less than 1 and fail
        // the schema, which is a confusing way to report "the compression did nothing".
        ratio: Math.max(1, source.length / Math.max(1, material.length)),
        note: bulletList(
          digests.map((digest) => digest.droppedNote),
          'The digests reported dropping nothing, which is worth reviewing.',
        ),
      },
      traces: traces.traces,
    });
  }
}

/**
 * Folds the digests into the block the normalisation call reads.
 *
 * Exported because the intake use-cases hand it straight to a prompt and a test needs to
 * be able to assert on what a model was actually shown.
 */
export function renderDigests(digests: readonly NarrativeDigest[]): string {
  return composePrompt(
    ...digests.map((digest, index) =>
      composePrompt(
        `### Passage ${String(index + 1)}`,
        digest.synopsis,
        section('Events', bulletList(digest.events)),
        section('Characters', inlineList(digest.charactersSeen)),
        section('Places', inlineList(digest.placesSeen)),
        section('Planted', bulletList(digest.promisesPlanted, 'nothing new')),
        section('Paid off', bulletList(digest.promisesPaid, 'nothing')),
        section('Left out', orElse(digest.droppedNote, 'not stated')),
      ),
    ),
  );
}
