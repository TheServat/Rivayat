/**
 * The two clocks, factored out of the things that carry them.
 *
 * `Relation` and `Fact` are both bi-temporal, and they have to be bi-temporal *in the
 * same way*: docs/02 §3 defines exactly one pair of clocks for the whole world model,
 * and the query that reads it - "what was true during episode 2, according to what we
 * believe today" - is a half-open range test on each. That query is written once, in
 * SQL, against four column names. Two schemas spelling those four names slightly
 * differently would need two versions of it, and the second one is the one that gets
 * the retraction test backwards.
 *
 * So the fields themselves are shared, not merely the check over them. Spreading
 * {@link biTemporalShape} is what guarantees a new bi-temporal thing joins the existing
 * index rather than growing a parallel one, and {@link checkBiTemporalOrder} is the
 * single copy of the two invariants that JSON Schema cannot express - which means the
 * model filling either schema has never been told them, and `safeParse` is the only
 * thing standing between an inverted interval and the store.
 */

import { z } from 'zod';

import { IsoInstant, StoryTime } from '../primitives/common';

/**
 * The four fields, with their wording.
 *
 * Exported as a shape fragment rather than as a nested object because both clocks are
 * indexed and queried independently - the hot query is a range test on one of them -
 * and because the JSON Schema an LLM fills reads better flat. Spread it into a
 * `z.strictObject`; do not re-declare its members.
 */
export const biTemporalShape = {
  validFrom: StoryTime.nullable()
    .default(null)
    .describe(
      'When this became true in the story. `null` means it was already true before the story opens.',
    ),
  validUntil: StoryTime.nullable()
    .default(null)
    .describe('When it stopped being true in the story. `null` means it still holds.'),

  assertedAt: IsoInstant.describe('The real instant we wrote this down.'),
  retractedAt: IsoInstant.nullable()
    .default(null)
    .describe(
      'The real instant we stopped believing we wrote it. `null` means the assertion still stands. NOT the same as `validUntil`: retraction un-says the sentence, `validUntil` ends the fact.',
    ),
} as const;

/**
 * A point on each clock, as a schema in its own right.
 *
 * Exists so a repository, a query builder or a test can name "the bi-temporal window"
 * once instead of listing four fields, and so the argument type of
 * {@link checkBiTemporalOrder} is inferred from a schema like everything else here.
 */
export const BiTemporal = z.strictObject(biTemporalShape);
export type BiTemporal = z.infer<typeof BiTemporal>;

/**
 * Both ordering invariants, in one place.
 *
 * Neither survives `z.toJSONSchema` - object-level refinements are dropped entirely -
 * so neither reaches the model that fills a `Relation` or a `Fact`, and both are
 * violated in practice: an extractor asked for a validity interval will occasionally
 * hand back an inverted one, and a repair loop that retracts an assertion will
 * occasionally stamp it before the assertion it retracts.
 *
 * The two are checked separately and reported on their own paths because they mean
 * different things and take different fixes. An inverted story-time interval is a
 * mis-read of the fiction; a retraction that precedes its assertion is a clock or an
 * ordering bug in our own pipeline, and telling the repair loop which one it is saves
 * it a turn.
 */
export function checkBiTemporalOrder(value: BiTemporal, ctx: z.RefinementCtx): void {
  const { validFrom, validUntil, assertedAt, retractedAt } = value;
  if (validFrom !== null && validUntil !== null && validUntil.ordinal < validFrom.ordinal) {
    ctx.addIssue({
      code: 'custom',
      path: ['validUntil'],
      message: 'validUntil must not precede validFrom',
    });
  }
  if (retractedAt !== null && Date.parse(retractedAt) < Date.parse(assertedAt)) {
    ctx.addIssue({
      code: 'custom',
      path: ['retractedAt'],
      message: 'retractedAt must not precede assertedAt',
    });
  }
}
