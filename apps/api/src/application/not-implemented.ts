/**
 * The honest answer for a port whose engine is still a scaffold.
 *
 * Six of the fourteen workspace packages are one-line placeholders today. There are
 * three ways to handle that in the composition root and only one of them is honest:
 *
 *  - Leave the module out. The route 404s, which tells a client "you got the URL
 *    wrong" when the truth is "we have not built it".
 *  - Return a plausible fake. The client integrates against it and finds out later.
 *  - Bind the port to something that says exactly this, in the taxonomy, with the
 *    package that owes the work named in the context.
 *
 * `UnsupportedCapabilityError` maps to 501 Not Implemented, which is the status that
 * means what we mean. The wiring, the routing, the validation and the error mapping
 * are all exercised by the stub - so the day the engine lands, only the binding in
 * `app.module.ts` changes.
 */

import { UnsupportedCapabilityError, type Result, err } from '@rv/shared-kernel';

/**
 * A refusal that names the capability and the package that owes it.
 *
 * @param capability what was asked for, in the port's own vocabulary
 * @param owner the workspace package that will implement it, e.g. `@rv/story-engine`
 */
export function notImplemented<T>(capability: string, owner: string): Result<T> {
  return err(
    new UnsupportedCapabilityError(
      owner,
      `${capability} - ${owner} is scaffolded; see docs/03-backlog.md for the story that implements it`,
    ),
  );
}

/** The async form, which is what every port method actually returns. */
export function notImplementedAsync<T>(capability: string, owner: string): Promise<Result<T>> {
  return Promise.resolve(notImplemented<T>(capability, owner));
}
