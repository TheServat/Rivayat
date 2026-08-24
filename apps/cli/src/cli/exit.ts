/**
 * Exit codes are part of the CLI's contract, so they live in one table and are
 * asserted by tests.
 *
 * A script that wraps `rv` needs to tell four things apart, and "non-zero" tells it
 * none of them: a machine that mis-typed a flag should be fixed, a run that hit an
 * unreachable provider should be retried, a continuity contradiction should stop a
 * release, and a refused spend should prompt a human. Collapsing those into `1` is how
 * CI pipelines end up retrying the one failure that will never succeed.
 */
export const EXIT = {
  /** The command did what was asked. */
  ok: 0,
  /** The command ran and the operation failed - unreachable provider, bad input data. */
  failed: 1,
  /** The command line itself was wrong: unknown command, missing argument, bad value. */
  usage: 2,
  /**
   * The command succeeded and what it inspected is not clean.
   *
   * `continuity check` on a contradiction and `anim lint` on a broken file both land
   * here. Distinct from {@link EXIT.failed} because the tool worked perfectly; the
   * artefact did not.
   */
  findings: 3,
  /**
   * Money would have been spent and nobody said yes.
   *
   * Non-negotiable #3 makes the estimate a precondition of the call, so a command that
   * would leave the free lane stops here with the estimate printed and nothing spent.
   */
  spendRefused: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
