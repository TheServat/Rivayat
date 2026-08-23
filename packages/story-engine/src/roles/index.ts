/**
 * The staffed roles, instantiated.
 *
 * Five of the six are module-level constants because they do not vary: there is one
 * screenwriter, and pinning a different model to the story stage does not make it a
 * different screenwriter. The sixth, the actor, is a factory - see {@link actorRoleFor}.
 *
 * A registry map rather than a `switch` on `RoleId`, per CLAUDE.md §2: adding a role
 * means adding a member to `ROLE_IDS` and an entry here, and the `satisfies` clause makes
 * forgetting the second half a compile error rather than a runtime `undefined`.
 */

import type { CastMember } from '../support/cast-member';
import { inlineList, orElse } from '../support/format';
import {
  ACTOR_PROMPT,
  ART_DIRECTOR_PROMPT,
  CONTINUITY_EDITOR_PROMPT,
  DIRECTOR_PROMPT,
  PRODUCER_PROMPT,
  SCREENWRITER_PROMPT,
} from './prompts';
import { type AgentRole, type RoleId, buildRole } from './role';
import {
  ARC_MOVEMENT,
  CANON_RESPECT,
  CHARACTER_DISTINCTNESS,
  ENGAGEMENT,
  PREMISE_CLARITY,
  SCENE_CAUSALITY,
  SCOPE_FEASIBILITY,
  SILHOUETTE_READABILITY,
  STAKES,
  STYLE_FIT,
  VOICE_FIDELITY,
  WORLD_CONSISTENCY,
} from './rubrics';

const NO_VARS = {} as const;

/**
 * Structure. Routed at the story stage on the strong tier, because docs/01 §4 marks S2
 * "strong" and an outline is the one artefact every later stage is derived from.
 */
export const SCREENWRITER: AgentRole = buildRole({
  id: 'screenwriter',
  title: 'Screenwriter',
  stage: 'story',
  task: 'story-outline',
  tier: 'final',
  temperature: 0.7,
  template: SCREENWRITER_PROMPT,
  vars: NO_VARS,
  rubric: [PREMISE_CLARITY, STAKES, ARC_MOVEMENT, SCENE_CAUSALITY],
});

/** Reconciliation and staging. Runs at the sequence stage, where the shot list is cut. */
export const DIRECTOR: AgentRole = buildRole({
  id: 'director',
  title: 'Director',
  stage: 'sequence',
  task: 'scene-write',
  tier: 'final',
  temperature: 0.6,
  template: DIRECTOR_PROMPT,
  vars: NO_VARS,
  rubric: [SCENE_CAUSALITY, CHARACTER_DISTINCTNESS, ENGAGEMENT],
});

/**
 * Intake and scope. The cheap tier on purpose: docs/01 §4 marks S0 "cheap", and reading
 * a document for what is already in it is the one story job a local model does well.
 */
export const PRODUCER: AgentRole = buildRole({
  id: 'producer',
  title: 'Producer',
  stage: 'intake',
  task: 'story-outline',
  tier: 'draft',
  temperature: 0.2,
  template: PRODUCER_PROMPT,
  vars: NO_VARS,
  rubric: [PREMISE_CLARITY, STAKES, SCOPE_FEASIBILITY],
});

/** Canon. Temperature zero: an editor that improvises is not an editor. */
export const CONTINUITY_EDITOR: AgentRole = buildRole({
  id: 'continuity-editor',
  title: 'Continuity editor',
  stage: 'story',
  task: 'continuity-check',
  tier: 'preview',
  temperature: 0,
  template: CONTINUITY_EDITOR_PROMPT,
  vars: NO_VARS,
  rubric: [WORLD_CONSISTENCY, CANON_RESPECT],
});

/** Derived appearance and the prompts an image model receives. */
export const ART_DIRECTOR: AgentRole = buildRole({
  id: 'art-director',
  title: 'Art director',
  stage: 'cast',
  task: 'prompt-compose',
  tier: 'final',
  temperature: 0.5,
  template: ART_DIRECTOR_PROMPT,
  vars: NO_VARS,
  rubric: [STYLE_FIT, SILHOUETTE_READABILITY],
});

/**
 * One actor per character, bound to that character's `voice`.
 *
 * A factory rather than a constant, because the whole finding this implements is that a
 * single writing agent produces a cast who all sound the same (prior-art §B: IBSEN,
 * HoLLMwood). The variables below are read straight off the character sheet, so a role
 * cannot be built for a character whose sheet is missing them - which is the point of
 * making `voice` mandatory data in `CharacterPayload` rather than a note in the bible.
 *
 * `id` stays `'actor'` for routing and for the ledger; the instance is told apart by
 * `title` and, more usefully, by `systemPromptHash`, which differs per character exactly
 * because the voice block does.
 */
export function actorRoleFor(member: CastMember): AgentRole {
  const { voice, psych, motionSignature } = member.payload;
  return buildRole({
    id: 'actor',
    title: `${member.name} (actor)`,
    stage: 'sequence',
    task: 'scene-write',
    tier: 'final',
    temperature: 0.8,
    template: ACTOR_PROMPT,
    vars: {
      characterName: member.name,
      register: voice.register,
      verbosity: voice.verbosity,
      sentenceRhythm: voice.sentenceRhythm,
      humourMode: voice.humourMode,
      profanity: voice.profanity,
      idiolect: inlineList(voice.idiolect),
      verbalTics: inlineList(voice.verbalTics),
      silenceHabits: orElse(voice.silenceHabits, 'not recorded'),
      want: psych.want,
      need: psych.need,
      lie: psych.lie,
      flaws: inlineList(psych.flaws),
      fears: inlineList(psych.fears),
      tellOnLying: orElse(motionSignature.tellOnLying, 'not recorded'),
    },
    rubric: [VOICE_FIDELITY, CHARACTER_DISTINCTNESS],
  });
}

/**
 * The five fixed roles, addressable by id.
 *
 * `actor` is absent because it has no fixed instance; asking for one without naming a
 * character is the mistake this omission makes impossible.
 */
export const FIXED_ROLES = {
  screenwriter: SCREENWRITER,
  director: DIRECTOR,
  producer: PRODUCER,
  'continuity-editor': CONTINUITY_EDITOR,
  'art-director': ART_DIRECTOR,
} as const satisfies Partial<Record<RoleId, AgentRole>>;

export type FixedRoleId = keyof typeof FIXED_ROLES;

export type { AgentRole, RoleId, RubricDimension, RoleSpec } from './role';
export { ROLE_IDS, buildRole } from './role';
export type { ActorVars, NoVars } from './prompts';
export {
  ACTOR_PROMPT,
  ART_DIRECTOR_PROMPT,
  CONTINUITY_EDITOR_PROMPT,
  DIRECTOR_PROMPT,
  PRODUCER_PROMPT,
  SCREENWRITER_PROMPT,
} from './prompts';
export * from './rubrics';
