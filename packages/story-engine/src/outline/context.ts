/**
 * The unconditional context every outline call carries.
 *
 * docs/02 §4 puts `premise` and `rulesOfTheWorld` in the always-included set, and this is
 * the story engine's copy of that decision: an expansion that does not know the premise
 * writes a generically competent scene, and one that does not know the world's laws
 * writes a scene that breaks one.
 *
 * Held as a small flat interface rather than as the `SeriesBible` itself so that a caller
 * can expand an outline before a bible exists - which is exactly the situation the very
 * first expansion is in.
 */

import type { CanonPolicy, SeriesBible } from '@rv/contracts';
import { composePrompt, section } from '@rv/prompt-kit';

import { bulletList, inlineList } from '../support/format';

export interface OutlineContext {
  readonly seriesTitle: string;
  readonly premise: string;
  readonly themes: readonly string[];
  readonly tone: readonly string[];
  readonly genre: readonly string[];
  /** Fictional laws a scene can violate. Stated so a violation is checkable. */
  readonly worldRules: readonly string[];
  readonly canonPolicy: CanonPolicy;
  /** Runtime the plan has to fit. Absent when the shape is not decided yet. */
  readonly episodeDurationMs?: number;
}

/** Reads the context off a bible, so the two cannot drift. */
export function outlineContextFromBible(bible: SeriesBible): OutlineContext {
  return {
    seriesTitle: bible.title,
    premise: bible.premise,
    themes: bible.themes,
    tone: bible.tone,
    genre: bible.genre,
    worldRules: bible.rulesOfTheWorld.map(
      (rule) => `[${rule.scope}${rule.inviolable ? ', inviolable' : ''}] ${rule.statement}`,
    ),
    canonPolicy: bible.canonPolicy,
    episodeDurationMs: bible.targetFormat.episodeDurationMs,
  };
}

/** Renders the context as the block that opens every outline prompt. */
export function renderOutlineContext(context: OutlineContext): string {
  return composePrompt(
    `Series: ${context.seriesTitle}`,
    section('Premise', context.premise),
    `Themes: ${inlineList(context.themes)}`,
    `Tone: ${inlineList(context.tone)}`,
    `Genre: ${inlineList(context.genre)}`,
    section(
      'Laws of this world - a scene that breaks one is a bug',
      bulletList(context.worldRules, 'none declared'),
    ),
    section(
      'Canon policy',
      `Aired episodes freeze their facts: ${String(context.canonPolicy.freezeOnAir)}. ` +
        `Retcons: ${context.canonPolicy.retcon}. Checker strictness: ${context.canonPolicy.strictness}.`,
    ),
    context.episodeDurationMs === undefined
      ? undefined
      : `Each episode runs about ${(context.episodeDurationMs / 60_000).toFixed(1)} minutes.`,
  );
}
