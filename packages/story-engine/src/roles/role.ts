/**
 * Named agent roles as first-class objects.
 *
 * ViMax (prior-art §A) gets one thing unambiguously right: a pipeline staffed by named
 * roles with distinct system prompts beats one mega-prompt that tries to be a writer, a
 * director and a producer at once. The finding only pays off if the roles are *objects*
 * though - a role scattered across three template literals in three use-cases is a role
 * that drifts, cannot be routed independently, and cannot be held to a rubric.
 *
 * So a role carries three things and nothing else:
 *
 *  - **A system prompt**, rendered from a {@link PromptTemplate} rather than assembled at
 *    the call site, so the same role hashes to the same string every run and the response
 *    cache can actually hit.
 *  - **A `TaskKind` and a `PipelineStageKey`**, because the owner requires the model to be
 *    selectable per stage and the router keys off exactly that pair. A role that did not
 *    declare where it runs would have to be routed by its caller, and then two callers
 *    would disagree.
 *  - **A critique rubric** - the dimensions this role is answerable for. The critique pass
 *    does not invent its own questions; it asks the role's.
 */

import type { PipelineStageKey, QualityTier, TaskKind } from '@rv/contracts';
import type { Sha256 } from '@rv/shared-kernel';
import type { PromptTemplate, TemplateVars } from '@rv/prompt-kit';

/**
 * The six roles the story stages are staffed by.
 *
 * `actor` is the odd one out and deliberately so: it is instantiated *per character*
 * rather than once, because IBSEN / HoLLMwood (prior-art §B) show that a single writer
 * agent producing every character's lines is precisely what makes every character sound
 * the same. See `actorRoleFor`.
 */
export const ROLE_IDS = [
  'screenwriter',
  'director',
  'producer',
  'actor',
  'continuity-editor',
  'art-director',
] as const;

export type RoleId = (typeof ROLE_IDS)[number];

/**
 * One question a draft is scored against.
 *
 * `failsBelow` lives on the dimension rather than on the critique call because the
 * threshold is a property of *what is being asked*: "is the premise legible" tolerates a
 * 0.6 far worse than "does this contradict aired canon" does.
 */
export interface RubricDimension {
  /** Stable key. Appears in the structured critique output, so it must not drift. */
  readonly key: string;
  readonly label: string;
  /** The question, phrased so a 0 and a 1 are both imaginable. */
  readonly question: string;
  /** Score in `0..1` below which this dimension is a blocking finding. */
  readonly failsBelow: number;
}

export interface AgentRole {
  readonly id: RoleId;
  /** How the role introduces itself in its own prompt, e.g. `Kael (actor)`. */
  readonly title: string;
  readonly stage: PipelineStageKey;
  readonly task: TaskKind;
  readonly tier: QualityTier;
  /**
   * Sampling temperature for this role's calls.
   *
   * Not uniform, because the roles want opposite things: a continuity editor that
   * improvises is a bug, and a screenwriter pinned to 0 writes the median of its training
   * set. Determinism is preserved the way CLAUDE.md #1 requires it - through a seeded
   * `CallParams.seed` on the binding - not by flattening every role to greedy decoding.
   */
  readonly temperature: number;
  readonly systemPrompt: string;
  /** Hash of `systemPrompt`. Half of the response-cache key, and the provenance record. */
  readonly systemPromptHash: Sha256;
  readonly rubric: readonly RubricDimension[];
}

export interface RoleSpec<TVars extends TemplateVars> {
  readonly id: RoleId;
  readonly title: string;
  readonly stage: PipelineStageKey;
  readonly task: TaskKind;
  readonly tier: QualityTier;
  readonly temperature: number;
  readonly template: PromptTemplate<TVars>;
  readonly vars: TVars;
  readonly rubric: readonly RubricDimension[];
}

/**
 * Renders a role's template into a finished role.
 *
 * The single place a system prompt is produced, so the hash is computed the same way for
 * every role and a role can never be constructed with an unrendered `{{placeholder}}`
 * still in it - `PromptTemplate.render` throws on a missing variable rather than
 * interpolating the string "undefined" into a prompt nobody will read again.
 */
export function buildRole<TVars extends TemplateVars>(spec: RoleSpec<TVars>): AgentRole {
  const rendered = spec.template.render(spec.vars);
  return {
    id: spec.id,
    title: spec.title,
    stage: spec.stage,
    task: spec.task,
    tier: spec.tier,
    temperature: spec.temperature,
    systemPrompt: rendered.text,
    systemPromptHash: rendered.hash,
    rubric: spec.rubric,
  };
}
