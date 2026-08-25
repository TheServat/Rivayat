/**
 * The cast shortlist S0 produces and S3 writes sheets for.
 *
 * It lives in the contracts rather than inside `@rv/story-engine` because it crosses the
 * HTTP boundary: `POST /api/series/:id/intake` answers with it, and the studio renders
 * it. A shape a browser has to parse cannot live in an engine the browser must not
 * import - the dependency rule points inward, and `apps/web` depends on `@rv/contracts`
 * and `@rv/anim-engine` only.
 *
 * Auto-casting (prior-art SS A, from `AI-Story-To-Movie`) starts here: the recurring cast
 * has to be identified before any scene is composed, because the asset registry is keyed
 * on character identity rather than on scene.
 */

import { z } from 'zod';

import { Importance } from '../narrative/entity';
import { Label, Prose } from '../primitives/common';

export const CAST_ROLES = [
  'protagonist',
  'antagonist',
  'ally',
  'mentor',
  'foil',
  'love-interest',
  'minor',
] as const;

export const CastRole = z.enum(CAST_ROLES);
export type CastRole = z.infer<typeof CastRole>;

/**
 * A character the story cannot be told without, spotted at intake.
 *
 * Auto-casting (prior-art §A, from `AI-Story-To-Movie`) starts here: the recurring cast
 * has to be identified before any scene is composed, because the asset registry is keyed
 * on character identity rather than on scene. A candidate is not yet a character sheet -
 * it is the shortlist S3 will write sheets for.
 */
export const CastCandidate = z.strictObject({
  name: Label.describe(
    'The name the source uses, or the clearest handle it offers - "the ferryman" is a ' +
      'better answer than an invented name.',
  ),
  role: CastRole.describe('Structural function in this story, not job title.'),
  importance: Importance.describe(
    'How much screen time and budget this character has earned. Reserve "lead" for the ' +
      'one or two the series is about.',
  ),
  premiseRole: Prose.describe(
    'What this character does to the story, in one or two sentences. Not a biography - ' +
      'the reason the plot needs them.',
  ),
  distinguishingTrait: Prose.describe(
    'The single thing that makes them not interchangeable with the next character. If ' +
      'the source gives none, say that rather than inventing one.',
  ),
});
export type CastCandidate = z.infer<typeof CastCandidate>;
