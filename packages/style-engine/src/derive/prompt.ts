/**
 * The prompt that does the looking.
 *
 * Three things it is built to prevent, each of which was the obvious first draft:
 *
 *  1. **"Describe the style"** - returns a paragraph of adjectives that map onto
 *     nothing. Every question here has a closed answer set or a number.
 *  2. **"Fill in this style bible"** - returns the middle option for every field. The
 *     model is never shown the bible's vocabulary at all.
 *  3. **Averaging across the references** - a model handed four images silently blends
 *     them. It is told instead to report what is *common* to them and to answer from
 *     the majority when they disagree, because a style is the thing they share.
 */

import { PromptTemplate, composePrompt, section } from '@rv/prompt-kit';

export const DERIVE_SYSTEM_PROMPT = [
  'You are an art director examining reference images to work out how they were made.',
  '',
  'Report only what you can see. Do not name a style, an artist or a studio; do not',
  'guess at intent. If a detail is not visible in any reference, answer with the option',
  'closest to "none" rather than inventing one.',
  '',
  'Where the references disagree, describe what most of them do - you are identifying',
  'the house style they share, not averaging them into a new one.',
  '',
  'Count when asked to count. "How many distinct shadow tones" means look at one',
  'surface and count the flat areas of different darkness on it.',
].join('\n');

const USER_TEMPLATE = new PromptTemplate<{
  readonly referenceCount: number;
  readonly context: string;
}>(
  'derive-style-observations',
  [
    'There are {{referenceCount}} reference image(s) attached.',
    '',
    'Work through them in this order and answer every question:',
    '',
    '1. SURFACE - what does the artwork appear to be physically made of, and what',
    '   specific visible detail tells you that?',
    '2. OUTLINE - is there one? How thick relative to the forms? Does its width vary',
    '   along a stroke? What colour is it relative to the shape it borders? Is it',
    '   ruler-steady or hand-drawn?',
    '3. SHADING - pick one large surface and count the distinct tones on it. Is the',
    '   boundary between them a hard edge, a soft blend, hatching, or dots? Which',
    '   direction is the key light coming from?',
    '4. TEXTURE - grain, paper tooth, printed dots, brush marks, torn edges: for each,',
    '   is it absent, subtle, noticeable or dominant?',
    '5. FORM - are corners sharp or round? How far from realistic are the proportions?',
    '   How many head-heights tall is a figure? How dense is the detail?',
    '6. COLOUR - list the colours you can actually see as hex, with a plain name and',
    '   where each appears. Name the relationship between them and the overall',
    '   value contrast.',
    '7. ABSENT - what would an image generator add by default that these references',
    '   clearly do not have?',
    '{{context}}',
  ].join('\n'),
);

export interface DerivePromptInput {
  readonly referenceCount: number;
  /** Optional brief from S0 Intake. Context only - it must never override the pixels. */
  readonly brief?: string;
}

export function buildDerivePrompt(input: DerivePromptInput): string {
  return USER_TEMPLATE.render({
    referenceCount: input.referenceCount,
    context: composePrompt(
      section(
        'Project context (background only - the references are the authority)',
        input.brief ?? '',
      ),
    ),
  }).text;
}
