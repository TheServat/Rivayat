import { type AnySettingDescriptor, isSettingKey, settingFor } from '@rv/contracts';
import { z } from 'zod';

/**
 * The descriptor's own schema, in the browser.
 *
 * This used to reconstruct a validator from `control` and a bag of `constraints`,
 * because a Zod schema could not cross the wire and the studio had nothing else to
 * work from. It apologised for the resulting asymmetry - "a value this accepts may
 * still be rejected by the API" - and the apology is now obsolete: the registry ships
 * in `@rv/contracts`, which the studio already depends on, so the object handed back
 * here is **the same schema object `apps/api` validates the patch with**. Not a
 * reconstruction of it, not a subset - the same declaration, executed twice.
 *
 * That matters for one behaviour in particular. A form that guesses conservatively
 * refuses values the server would have taken, and the user has no way to tell a real
 * rule from a client-side approximation of one. There is no approximation left.
 *
 * An **unknown key returns `z.unknown()`**, which accepts anything. That is deliberate
 * and it is the one place asymmetry survives: a form cannot validate what the registry
 * does not declare, and refusing outright would break a studio that is one deploy
 * behind an API that has just added a setting. The server still has the last word - it
 * refuses an unknown key outright - so the failure is a rejected save with a named
 * field, not a stored value nothing understands.
 */
export function settingValidator(key: string): z.ZodType<unknown> {
  if (!isSettingKey(key)) return z.unknown();
  // Widened to `AnySettingDescriptor` on purpose: `settingFor` returns the union of
  // all sixty descriptor types, and the caller has a `string` - so the value type is
  // genuinely unknown here and pretending otherwise would need a cast.
  const descriptor: AnySettingDescriptor = settingFor(key);
  return descriptor.schema;
}
