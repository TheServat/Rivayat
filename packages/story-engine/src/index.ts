/**
 * `@rv/story-engine` - brief in, shot list out.
 *
 * It owns the four LLM story stages of docs/01 §4 - S0 Intake, S2 Story, S3 Cast and S7
 * Sequence - plus the critique pass that decides whether their output is good enough to
 * spend money on. What it does not own is anything with a socket: every model call goes
 * through `StructuredCall` from `@rv/prompt-kit`, routed by a `StageBackends` port, and
 * nothing here imports a vendor SDK.
 *
 * The package is organised around the techniques in docs/00b-prior-art.md §B rather than
 * around the pipeline stages, because that is where the interesting constraints live:
 *
 * | Directory  | Technique                        | The failure it prevents                     |
 * | ---------- | -------------------------------- | ------------------------------------------- |
 * | `roles/`   | ViMax named roles, IBSEN actors  | one voice writing the whole cast            |
 * | `intake/`  | ViMax `Novel2Video` compression  | a novel truncated to its first act          |
 * | `outline/` | DOC one-level descent, DOME      | episode 7 forgetting the antagonist         |
 * | `cast/`    | CHIRON psychology-first sheets   | three expressions and one outfit            |
 * | `scene/`   | IBSEN / HoLLMwood actor-director | characters knowing what they were not told  |
 * | `shots/`   | -                                | one composition that only works in 16:9     |
 * | `critique/`| StoryER, ConStory-Bench          | a weak draft discovered after the image bill |
 */

export type { StoryEngineDeps, StageCallOutcome, RoleCallArgs } from './support/stage-call';
export { runRoleCall, TraceLog } from './support/stage-call';
export type { CastMember } from './support/cast-member';
export type { StyleBrief } from './support/style-brief';
export { styleBriefFrom } from './support/style-brief';
export {
  bulletList,
  inlineList,
  normaliseForComparison,
  orElse,
  orderedList,
  slugify,
} from './support/format';

export type {
  StageBackends,
  StageCallSpec,
  RoutedStageBackendsDeps,
} from './routing/stage-backends';
export { FixedStageBackends, RoutedStageBackends } from './routing/stage-backends';

export * from './roles/index';
export * from './intake/index';
export * from './outline/index';
export * from './cast/index';
export * from './scene/index';
export * from './shots/index';
export * from './critique/index';
