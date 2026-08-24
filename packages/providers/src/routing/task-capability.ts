/**
 * Which port each kind of work needs.
 *
 * A lookup table, not a `switch`: adding a `TaskKind` in `@rv/contracts` breaks this
 * object at compile time (`satisfies Record<TaskKind, Capability>`), which is exactly
 * where the omission should surface. A `switch` in the router would instead surface it
 * as a runtime `assertNever` on the first call in production.
 */

import type { Capability, TaskKind } from '@rv/contracts';

export const TASK_CAPABILITY = {
  // The story stages are structured work: a beat sheet, a cast list and a shot list
  // are all shapes the domain validates, so they route to `structured-generation`.
  'story-outline': 'structured-generation',
  // Prose the audience reads. There is nothing to validate, so a plain text model
  // does, and forcing it through a schema would only flatten the writing.
  'scene-write': 'text-generation',
  'character-sheet': 'structured-generation',
  'style-derive': 'structured-generation',
  'asset-spec': 'structured-generation',
  'prompt-compose': 'structured-generation',
  'continuity-check': 'structured-generation',
  'image-draft': 'image-generation',
  'image-final': 'image-generation',
  'image-edit': 'image-edit',
  'vision-score': 'vision-scoring',
  embed: 'embedding',
  'speech-line': 'speech-synthesis',
} as const satisfies Record<TaskKind, Capability>;

export function capabilityForTask(task: TaskKind): Capability {
  return TASK_CAPABILITY[task];
}
