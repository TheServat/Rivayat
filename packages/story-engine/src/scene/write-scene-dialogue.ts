/**
 * The actor/director loop: how characters stop sounding identical.
 *
 * Prior-art §B takes this from IBSEN, HoLLMwood and Agents' Room, and the mechanism is
 * not "prompt it to vary the voices". It is structural:
 *
 *  1. **One call per speaker.** Each is the {@link actorRoleFor} role for that character,
 *     whose system prompt is rendered from that character's `voice` block. Two actors
 *     receive genuinely different instructions because they are genuinely different
 *     objects.
 *  2. **Each actor is handed only what its character knows.** Not a filtered version of
 *     the truth - a different object entirely, built from that character's
 *     `EpistemicView`. See {@link SceneSpeaker.view}.
 *  3. **A director pass reconciles the takes.** The actors could not hear each other, so
 *     what comes back is three monologues; the director cuts, reorders, times, and adjusts
 *     only where a line must answer the line before it.
 *
 * What is recorded matters as much as what is produced. The reconciliation note and the
 * cut lines are returned, so "the director flattened her" is a diff rather than an
 * impression, and every speaker's verbal tics are checked for survival because a tic
 * smoothed away is a character flattened.
 */

import { z } from 'zod';
import {
  DeliveryNote,
  type DialogueLine,
  type EntityId,
  type EpistemicView,
  Millis,
  NonNegativeInt,
  PositiveInt,
  Prose,
  type Scene,
} from '@rv/contracts';
import { PromptTemplate, type StructuredTrace, composePrompt, section } from '@rv/prompt-kit';
import { type AppError, type Result, ValidationError, err, isErr, ok } from '@rv/shared-kernel';

import { DIRECTOR, actorRoleFor } from '../roles/index';
import type { CastMember } from '../support/cast-member';
import { bulletList, inlineList, orElse } from '../support/format';
import { type StoryEngineDeps, TraceLog, runRoleCall } from '../support/stage-call';
import { renderEpistemicBriefing } from './epistemic-briefing';
import type { SceneStaging } from './staging';

// ── input ───────────────────────────────────────────────────────────────────

export interface SceneSpeaker {
  readonly member: CastMember;
  /**
   * What **this character** knows, at this story moment, resolved for them alone.
   *
   * This parameter exists to prevent one specific bug, and it is worth naming it: passing
   * the omniscient view - or the same view for every speaker, or the POV character's view
   * to the character they are lying to - produces a scene in which everybody already knows
   * everything. It reads as *competent*, which is why it survives review: the lines are
   * fine, the pacing is fine, and the only thing wrong is that the dramatic irony the whole
   * episode was built on has quietly evaporated.
   *
   * Resolve it per speaker with `viewFor(character, storyTime)` against the bi-temporal
   * graph. If you find yourself reaching for the world state here, that is the bug.
   */
  readonly view: EpistemicView;
  /** What this character is trying to get out of this scene, in their own terms. */
  readonly objective: string;
}

export interface WriteSceneDialogueInput {
  /**
   * The full scene, narrator's view included.
   *
   * Read by the **director only**. The actors never see it - that is what `staging` is
   * for.
   */
  readonly scene: Scene;
  /** The observable surface of the room. This is what every actor is shown. */
  readonly staging: SceneStaging;
  /** In the order they should be given the floor. At least one. */
  readonly speakers: readonly SceneSpeaker[];
  readonly maxLinesPerActor?: number;
  readonly signal?: AbortSignal;
}

// ── drafts ──────────────────────────────────────────────────────────────────

export const ActorLine = z.strictObject({
  text: Prose.describe('The words spoken, verbatim, in the series language.'),
  subtext: Prose.describe(
    'What the character is doing with this line, under the words. If they mean exactly ' +
      'what they say, write that.',
  ),
  delivery: DeliveryNote,
  cueNote: Prose.describe(
    'What in the room prompts this line - what they saw, heard or decided. Not what ' +
      'another character said, because you cannot hear them.',
  ),
});
export type ActorLine = z.infer<typeof ActorLine>;

export const ActorTake = z.strictObject({
  lines: z
    .array(ActorLine)
    .min(1)
    .max(24)
    .describe('Everything your character says in this scene, in the order they would say it.'),
  withheld: Prose.describe(
    'What your character is deliberately not saying, and why. The director uses this to ' +
      'decide where a silence lands.',
  ),
  refusals: z
    .array(Prose)
    .max(8)
    .default([])
    .describe(
      'Anything the scene seems to want from your character that they would not do. Say so ' +
        'rather than doing it out of character.',
    ),
});
export type ActorTake = z.infer<typeof ActorTake>;

/**
 * One reconciled line.
 *
 * The speaker is addressed by position in the speaker list, not by `EntityId`, for the
 * reason `AssetInstanceKey` is a slug: a model re-quoting a prefixed ULID across a
 * structured response produces one that nearly matches, and "nearly" here attributes a
 * line to the wrong character.
 */
export const DirectedLine = z.strictObject({
  speakerOrdinal: PositiveInt.describe('Which speaker says this, by their number in the list.'),
  text: Prose,
  subtext: Prose,
  delivery: DeliveryNote,
  startMs: Millis.default(0).describe(
    'Offset from the start of the scene, in milliseconds. Overlapping lines are ' +
      'interruptions and are allowed.',
  ),
  fromTakeLine: NonNegativeInt.nullable()
    .default(null)
    .describe(
      "Which line of that actor's take this came from, zero-based. Null for a line you " + 'added.',
    ),
  changeNote: Prose.describe(
    'What you changed from the take and why it had to change. Write "unchanged" when you ' +
      'took the line as given.',
  ),
});
export type DirectedLine = z.infer<typeof DirectedLine>;

export const DirectedScene = z.strictObject({
  lines: z.array(DirectedLine).min(1).max(96).describe('The scene as performed, in order.'),
  reconciliationNote: Prose.describe(
    'One paragraph: what the takes disagreed about and how you resolved it.',
  ),
  cutLines: z
    .array(Prose)
    .max(32)
    .default([])
    .describe('Lines you dropped, quoted. Recorded so a writer can argue with the cut.'),
});
export type DirectedScene = z.infer<typeof DirectedScene>;

// ── prompts ─────────────────────────────────────────────────────────────────

/**
 * The actor's user turn.
 *
 * Every variable here is either the observable staging or this character's own briefing.
 * There is no slot for the scene summary, the outcome, or the series premise, and that
 * absence is the guarantee - a prompt cannot leak a field it has nowhere to put.
 */
const ACTOR_TAKE_PROMPT = new PromptTemplate<{
  readonly sceneTitle: string;
  readonly location: string;
  readonly timeNote: string;
  readonly toneNote: string;
  readonly present: string;
  readonly observable: string;
  readonly briefing: string;
  readonly objective: string;
  readonly lineBudget: string;
}>(
  'scene.actor-take',
  [
    '## Where you are',
    'Scene: {{sceneTitle}}',
    'Place: {{location}}',
    'When: {{timeNote}}',
    'In the room with you: {{present}}',
    '',
    '## What you can see and hear',
    '{{observable}}',
    '',
    '## What you know',
    '{{briefing}}',
    '',
    '## What you want out of this',
    '{{objective}}',
    '',
    '## Tone',
    '{{toneNote}}',
    '',
    '## Your task',
    'Give your lines for this scene, in the order you would say them. {{lineBudget}}',
    '',
    'You cannot hear the other performances. Do not answer lines nobody has said yet, and',
    'do not narrate what anyone else does. If you are waiting for something, say what you do',
    'while you wait.',
  ].join('\n'),
);

const DIRECTOR_PROMPT_TEMPLATE = new PromptTemplate<{
  readonly sceneTitle: string;
  readonly sceneSummary: string;
  readonly goal: string;
  readonly conflict: string;
  readonly outcome: string;
  readonly valueShift: string;
  readonly beats: string;
  readonly speakers: string;
  readonly takes: string;
}>(
  'scene.director-reconcile',
  [
    '## The scene as planned',
    'Title: {{sceneTitle}}',
    '{{sceneSummary}}',
    '',
    'Goal: {{goal}}',
    'Conflict: {{conflict}}',
    'Outcome: {{outcome}}',
    'Value turned: {{valueShift}}',
    '',
    '### Beats it has to carry',
    '{{beats}}',
    '',
    '## Who is speaking',
    '{{speakers}}',
    '',
    '## The takes',
    'Each actor recorded these without hearing the others.',
    '',
    '{{takes}}',
    '',
    '## Your task',
    'Cut these into one scene. Order the lines, time them from the start of the scene, and',
    'let people interrupt and talk past each other where that is what would happen.',
    '',
    'Change a line only where it must change to answer the line before it, and when you do,',
    "keep the speaker's own diction - their register, their rhythm, and any verbal tic their",
    'sheet lists. Record every change and every cut.',
    '',
    'Do not give a character information their take shows they do not have. If an exchange',
    'only works because someone knows something they were never told, cut the exchange.',
  ].join('\n'),
);

// ── results ─────────────────────────────────────────────────────────────────

export interface ActorTakeRecord {
  readonly entityId: EntityId;
  readonly name: string;
  readonly take: ActorTake;
}

/** Whether a speaker's verbal tics survived reconciliation. RV-086's lexical check. */
export interface VoiceFinding {
  readonly entityId: EntityId;
  readonly name: string;
  readonly tics: readonly string[];
  readonly retainedTics: readonly string[];
  /** True when the character has tics on their sheet and none of them survived. */
  readonly flattened: boolean;
}

export interface SceneDialogueResult {
  readonly lines: readonly DialogueLine[];
  readonly takes: readonly ActorTakeRecord[];
  readonly reconciliationNote: string;
  readonly cutLines: readonly string[];
  readonly voiceFindings: readonly VoiceFinding[];
  readonly traces: readonly StructuredTrace[];
}

// ── the use-case ────────────────────────────────────────────────────────────

export class WriteSceneDialogueUseCase {
  readonly #deps: StoryEngineDeps;

  constructor(deps: StoryEngineDeps) {
    this.#deps = deps;
  }

  async execute(input: WriteSceneDialogueInput): Promise<Result<SceneDialogueResult, AppError>> {
    if (input.speakers.length === 0) {
      return err(
        new ValidationError({
          message: 'A scene needs at least one speaker to write dialogue for',
          context: { reason: 'no-speakers', sceneId: input.scene.id },
        }),
      );
    }

    const mismatched = input.speakers.filter(
      (speaker) => speaker.view.viewerId !== speaker.member.entityId,
    );
    if (mismatched.length > 0) {
      // The cheapest possible catch for the bug `SceneSpeaker.view` documents: a view whose
      // `viewerId` is someone else is, by definition, somebody else's knowledge.
      return err(
        new ValidationError({
          message:
            'A speaker was given an epistemic view belonging to a different entity: ' +
            mismatched.map((speaker) => speaker.member.name).join(', '),
          context: {
            reason: 'epistemic-view-mismatch',
            speakers: mismatched.map((speaker) => speaker.member.entityId),
            viewers: mismatched.map((speaker) => speaker.view.viewerId),
          },
        }),
      );
    }

    const traces = new TraceLog();
    const takes: ActorTakeRecord[] = [];

    // Sequential, not parallel. Not for correctness - the actors are independent by
    // construction - but so a replayed run issues the calls in the same order and the
    // response cache is hit in the same order.
    for (const speaker of input.speakers) {
      const take = await this.#recordTake(input, speaker);
      if (isErr(take)) return take;
      traces.add(take.value.trace);
      takes.push({
        entityId: speaker.member.entityId,
        name: speaker.member.name,
        take: take.value.value,
      });
    }

    const directed = await this.#reconcile(input, takes);
    if (isErr(directed)) return directed;
    traces.add(directed.value.trace);

    const lines = resolveSpeakers(directed.value.value.lines, input.speakers);
    if (isErr(lines)) return lines;

    return ok({
      lines: lines.value,
      takes,
      reconciliationNote: directed.value.value.reconciliationNote,
      cutLines: directed.value.value.cutLines,
      voiceFindings: checkTicRetention(lines.value, input.speakers),
      traces: traces.traces,
    });
  }

  async #recordTake(
    input: WriteSceneDialogueInput,
    speaker: SceneSpeaker,
  ): Promise<Result<{ value: ActorTake; trace: StructuredTrace }, AppError>> {
    const budget = input.maxLinesPerActor;
    return runRoleCall<ActorTake>(this.#deps, {
      role: actorRoleFor(speaker.member),
      schemaName: 'ActorTake',
      schema: ActorTake,
      user: ACTOR_TAKE_PROMPT.render({
        sceneTitle: input.staging.title,
        location: input.staging.locationName,
        timeNote: orElse(input.staging.timeNote, 'not stated'),
        toneNote: orElse(input.staging.toneNote, 'as the series usually sounds'),
        present: inlineList(
          input.staging.presentNames.filter((name) => name !== speaker.member.name),
          'you are alone',
        ),
        observable: input.staging.observable,
        briefing: renderEpistemicBriefing(speaker.view, speaker.member.name),
        objective: speaker.objective,
        lineBudget:
          budget === undefined
            ? 'Say as much or as little as the character would.'
            : `At most ${String(budget)} lines.`,
      }).text,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async #reconcile(
    input: WriteSceneDialogueInput,
    takes: readonly ActorTakeRecord[],
  ): Promise<Result<{ value: DirectedScene; trace: StructuredTrace }, AppError>> {
    const { scene } = input;
    return runRoleCall<DirectedScene>(this.#deps, {
      role: DIRECTOR,
      schemaName: 'DirectedScene',
      schema: DirectedScene,
      user: DIRECTOR_PROMPT_TEMPLATE.render({
        sceneTitle: scene.title,
        sceneSummary: scene.summary,
        goal: scene.goal,
        conflict: scene.conflict,
        outcome: scene.outcome,
        valueShift: `${scene.valueShift.axis}: ${scene.valueShift.from} to ${scene.valueShift.to}`,
        beats: bulletList(
          scene.beats.map((beat) => `[${beat.function}] ${beat.title} - ${beat.summary}`),
        ),
        speakers: bulletList(
          input.speakers.map(
            (speaker, index) =>
              `${String(index + 1)}. ${speaker.member.name} - wants: ${speaker.objective}; tics: ${inlineList(speaker.member.payload.voice.verbalTics, 'none')}`,
          ),
        ),
        takes: renderTakes(takes),
      }).text,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
}

// ── post-processing ─────────────────────────────────────────────────────────

function renderTakes(takes: readonly ActorTakeRecord[]): string {
  return composePrompt(
    ...takes.map((record, index) =>
      composePrompt(
        `### Speaker ${String(index + 1)}: ${record.name}`,
        bulletList(
          record.take.lines.map(
            (line, lineIndex) =>
              `[${String(lineIndex)}] "${line.text}" (subtext: ${line.subtext}; ${line.delivery.emotion} at ${line.delivery.intensity.toFixed(2)}, ${line.delivery.pace}, ${line.delivery.volume})`,
          ),
        ),
        section('Withholding', record.take.withheld),
        section('Would not do', bulletList(record.take.refusals, 'nothing refused')),
      ),
    ),
  );
}

/**
 * Turns the director's ordinals back into entity references.
 *
 * A line attributed to a speaker who is not in the scene is a hard failure rather than a
 * dropped line: it means the director invented a participant, and a scene missing a line
 * nobody noticed is worse than a scene that failed loudly.
 */
export function resolveSpeakers(
  lines: readonly DirectedLine[],
  speakers: readonly SceneSpeaker[],
): Result<readonly DialogueLine[], ValidationError> {
  const resolved: DialogueLine[] = [];
  for (const line of lines) {
    const speaker = speakers[line.speakerOrdinal - 1];
    if (speaker === undefined) {
      return err(
        new ValidationError({
          message: `Directed line names speaker ${String(line.speakerOrdinal)}; there are ${String(speakers.length)} in this scene`,
          context: {
            reason: 'unknown-speaker-ordinal',
            ordinal: line.speakerOrdinal,
            speakerCount: speakers.length,
          },
        }),
      );
    }
    resolved.push({
      speakerRef: speaker.member.entityId,
      text: line.text,
      subtext: line.subtext,
      delivery: line.delivery,
      startMs: line.startMs,
      // `durationMs` and `phonemes` are deliberately absent: they are measured from
      // rendered audio, and a guess here would be indistinguishable from a measurement.
      phonemes: [],
    });
  }
  return ok(resolved.sort((left, right) => left.startMs - right.startMs));
}

/**
 * RV-086's lexical check: did the tics survive the director?
 *
 * A finding rather than a failure. A tic that vanished from a two-line scene is often
 * correct, and failing the scene over it would make the check something people turn off.
 * What it is not allowed to be is invisible.
 */
export function checkTicRetention(
  lines: readonly DialogueLine[],
  speakers: readonly SceneSpeaker[],
): readonly VoiceFinding[] {
  return speakers.map((speaker) => {
    const spoken = lines
      .filter((line) => line.speakerRef === speaker.member.entityId)
      .map((line) => line.text.toLowerCase())
      .join('   ');
    const tics = speaker.member.payload.voice.verbalTics;
    const retainedTics = tics.filter((tic) => spoken.includes(tic.toLowerCase()));
    return {
      entityId: speaker.member.entityId,
      name: speaker.member.name,
      tics,
      retainedTics,
      flattened: tics.length > 0 && retainedTics.length === 0,
    };
  });
}
