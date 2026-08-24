/**
 * `rv character "<idea>"` - a real character sheet, from the local model, validated.
 *
 * This is the smallest honest demonstration of the whole text layer: a real prompt goes
 * to `qwen3.5` through Ollama's native endpoint, the response comes back through
 * `StructuredCall`'s extract -> validate -> repair loop, and what is printed has been
 * parsed by the same Zod schema the rest of the system uses.
 *
 * It also makes the defect from research 1 visible rather than theoretical. Ollama does
 * not enforce the schema for this model, so the trace usually shows a fence being
 * stripped or a repair turn being spent - and that is the point of the wrapper.
 */

import { CharacterPayload } from '@rv/contracts';
import { StructuredCall, type StructuredBackend, type StructuredTrace } from '@rv/prompt-kit';
import { formatUsd, nanoUsd, type Logger } from '@rv/shared-kernel';
import { type z } from 'zod';

/**
 * A real slice of the contract, not a toy schema.
 *
 * `CharacterPayload` in full is a large document - `visual`, `arc` and
 * `motionSignature` on top of this - and a 6.6 GB local model will spend its whole
 * budget on it. These three are the CHIRON core: who they are, what drives them, and
 * how they speak. Ask for the rest with `--full`.
 */
export const CharacterCore = CharacterPayload.pick({
  identity: true,
  psych: true,
  voice: true,
});
export type CharacterCore = z.infer<typeof CharacterCore>;

const SYSTEM = [
  'You are a character designer for an animated series.',
  'Write psychology first: what the character wants, what they actually need, the wound',
  'that separates the two, and the lie they tell themselves. Appearance is derived from',
  'those, never the reverse.',
  'Give them a voice that no other character in the series could be mistaken for.',
].join('\n');

export interface CharacterResult {
  /**
   * A `CharacterCore` by default, and the whole `CharacterPayload` under `--full`.
   *
   * Typed as `unknown` rather than as the union of the two: both are validated by
   * their own schema inside `StructuredCall`, and the CLI only ever prints the result,
   * so a union here would be a second, unused claim about which one came back.
   */
  readonly value: unknown;
  readonly trace: StructuredTrace;
}

export async function generateCharacter(options: {
  readonly idea: string;
  readonly backends: readonly StructuredBackend[];
  readonly full: boolean;
  readonly logger?: Logger;
}): Promise<
  { ok: true; result: CharacterResult } | { ok: false; error: string; trace: StructuredTrace }
> {
  const schema = options.full ? CharacterPayload : CharacterCore;
  const call = new StructuredCall(options.logger === undefined ? {} : { logger: options.logger });

  const outcome = await call.run({
    schemaName: options.full ? 'CharacterPayload' : 'CharacterCore',
    schema,
    backends: options.backends,
    system: SYSTEM,
    user: `Design one character for this premise:\n\n${options.idea}`,
    maxRepairs: 3,
  });

  if (!outcome.ok) {
    return { ok: false, error: outcome.error.error.message, trace: outcome.error.trace };
  }
  return { ok: true, result: { value: outcome.value.value, trace: outcome.value.trace } };
}

/** The line that actually says whether the architecture earned its keep on this call. */
export function renderTrace(trace: StructuredTrace): string {
  const parts = [
    `model            ${trace.modelId}`,
    `resolution       ${trace.resolution}`,
    `attempts         ${String(trace.attempts)}  (repairs: ${String(trace.repairTurns)})`,
    `schema enforced  ${trace.usedNativeSchemaEnforcement ? 'natively by the provider' : 'no - validated and repaired downstream'}`,
    `recovery steps   ${trace.extractionSteps.length === 0 ? 'none needed' : trace.extractionSteps.join(', ')}`,
    `tokens           ${String(trace.usage.inputTokens)} in / ${String(trace.usage.outputTokens)} out`,
    `cost             ${formatUsd(nanoUsd(trace.costNanoUsd))}`,
    `latency          ${String(trace.totalLatencyMs)} ms`,
  ];
  if (trace.escalatedTo !== null) parts.push(`escalated to     ${trace.escalatedTo}`);
  if (trace.failedPaths.length > 0) parts.push(`last bad fields  ${trace.failedPaths.join(', ')}`);
  return parts.join('\n  ');
}
