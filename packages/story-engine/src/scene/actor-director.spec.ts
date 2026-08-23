/**
 * The most valuable test in this package.
 *
 * Everything else here can be wrong and produce a mediocre episode. If an actor call is
 * handed a fact its character does not have, the episode is *coherent* and the dramatic
 * irony the whole thing was built on is gone, and nobody notices until an audience does.
 *
 * So the assertion is on the literal prompt text sent to the fake backend, not on a call
 * count and not on the shape of the input. A mock verifying "three actor calls were made"
 * passes just as happily when all three were handed the omniscient view.
 */

import { describe, expect, it } from 'vitest';
import { Scene } from '@rv/contracts';
import { isErr } from '@rv/shared-kernel';

import { FakeStructuredBackend, respondError, respondJson } from '../__fixtures__/fakes';
import {
  IDS,
  castMember,
  contrastingVoicePayload,
  epistemicView,
  knownFact,
  scene,
  testDeps,
} from '../__fixtures__/builders';
import { factsInView, renderEpistemicBriefing } from './epistemic-briefing';
import type { SceneSpeaker, WriteSceneDialogueInput } from './write-scene-dialogue';
import {
  WriteSceneDialogueUseCase,
  checkTicRetention,
  resolveSpeakers,
} from './write-scene-dialogue';
import type { SceneStaging } from './staging';

/** The fact the scene is built on one character not having. */
const SECRET = 'The Sahar was scuttled for the insurance before it ever reached the shoal.';

const STAGING: SceneStaging = {
  title: 'The lamp room',
  locationName: 'The lamp room, top of the tower',
  presentNames: ['Mahtab', 'Bijan'],
  observable:
    'The wick is out and the glass is cold. Someone has come up the stairs behind her, ' +
    'still in an oilskin, dripping.',
  timeNote: 'An hour before the fleet reaches the shoal',
  toneNote: 'Dry, unhurried, nobody raises their voice.',
};

function bijan(): SceneSpeaker {
  return {
    member: castMember('Bijan', IDS.roya, contrastingVoicePayload()),
    // Bijan knows the secret.
    view: epistemicView(IDS.roya, {
      knows: [knownFact(SECRET, { relationId: IDS.relationTwo })],
      factCount: 1,
    }),
    objective: 'Say it before the fleet sails, and survive having said it.',
  };
}

function mahtab(): SceneSpeaker {
  return {
    member: castMember('Mahtab', IDS.mahtab),
    // Mahtab does not. The same relation sits in her blind spots, which is the dramatic
    // irony available to the scene - and is never rendered into a prompt.
    view: epistemicView(IDS.mahtab, {
      knows: [knownFact('The lamp has been out for an hour.')],
      blindSpots: [IDS.relationTwo],
      factCount: 2,
    }),
    objective: 'Get the lamp lit and get him back down the stairs.',
  };
}

function take(text: string): Record<string, unknown> {
  return {
    lines: [
      {
        text,
        subtext: 'Testing whether she already knows.',
        delivery: { emotion: 'wary', intensity: 0.5, pace: 'measured', volume: 'low' },
        cueNote: 'The cold glass.',
      },
    ],
    withheld: 'How long he has known.',
    refusals: [],
  };
}

function directed(lines: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    lines,
    reconciliationNote: 'Bijan leads; Mahtab answers a question he did not ask.',
    cutLines: [],
  };
}

function line(speakerOrdinal: number, text: string, startMs: number): Record<string, unknown> {
  return {
    speakerOrdinal,
    text,
    subtext: 'Holding the line.',
    delivery: { emotion: 'flat', intensity: 0.4, pace: 'measured', volume: 'low' },
    startMs,
    fromTakeLine: 0,
    changeNote: 'unchanged',
  };
}

function input(overrides: Partial<WriteSceneDialogueInput> = {}): WriteSceneDialogueInput {
  return {
    scene: scene(),
    staging: STAGING,
    speakers: [mahtab(), bijan()],
    ...overrides,
  };
}

function scriptedBackend(): FakeStructuredBackend {
  return new FakeStructuredBackend({
    script: [
      respondJson(take('Aye then. Hand me the spare wick.')),
      respondJson(take('There is a thing about that boat as it happens.')),
      respondJson(
        directed([
          line(2, 'There is a thing about that boat as it happens.', 1_200),
          line(1, 'Aye then. Hand me the spare wick.', 0),
        ]),
      ),
    ],
  });
}

describe('WriteSceneDialogueUseCase', () => {
  it('makes one actor call per speaker and one director call to reconcile them', async () => {
    const backend = scriptedBackend();
    const outcome = await new WriteSceneDialogueUseCase(testDeps(backend)).execute(input());

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(backend.callCount).toBe(3);
    expect(outcome.value.takes.map((record) => record.name)).toEqual(['Mahtab', 'Bijan']);
    expect(outcome.value.reconciliationNote).toContain('Bijan leads');
  });

  it('an actor without the fact never sees it, while the actor who has it does', async () => {
    const backend = scriptedBackend();
    await new WriteSceneDialogueUseCase(testDeps(backend)).execute(input());

    const mahtabPrompt = backend.promptAt(0);
    const bijanPrompt = backend.promptAt(1);

    // Bijan holds it, so it is in his briefing.
    expect(bijanPrompt).toContain(SECRET);
    // Mahtab does not. Not the sentence, not the distinctive word inside it, not the
    // relation id it hangs off.
    expect(mahtabPrompt).not.toContain(SECRET);
    expect(mahtabPrompt.toLowerCase()).not.toContain('scuttled');
    expect(mahtabPrompt).not.toContain(IDS.relationTwo);
    // What she does hold is there, so the absence above is a redaction rather than an
    // empty prompt.
    expect(mahtabPrompt).toContain('The lamp has been out for an hour.');
  });

  it("gives each actor every fact in its own view and no fact from anyone else's", async () => {
    const backend = scriptedBackend();
    const speakers = [mahtab(), bijan()];
    await new WriteSceneDialogueUseCase(testDeps(backend)).execute(input({ speakers }));

    speakers.forEach((speaker, index) => {
      const prompt = backend.promptAt(index).toLowerCase();
      const mine = factsInView(speaker.view);
      const theirs = speakers
        .filter((other) => other !== speaker)
        .flatMap((other) => factsInView(other.view));

      for (const fact of mine) expect(prompt).toContain(fact);
      for (const fact of theirs.filter((entry) => !mine.includes(entry))) {
        expect(prompt).not.toContain(fact);
      }
    });
  });

  it("withholds the narrator's account of the scene from every actor, and gives it to the director", async () => {
    const backend = scriptedBackend();
    const full = scene();
    await new WriteSceneDialogueUseCase(testDeps(backend)).execute(input({ scene: full }));

    for (const index of [0, 1]) {
      expect(backend.promptAt(index)).not.toContain(full.summary);
      expect(backend.promptAt(index)).not.toContain(full.outcome);
    }
    expect(backend.promptAt(2)).toContain(full.summary);
    expect(backend.promptAt(2)).toContain(full.outcome);
  });

  /**
   * The narrator's account of the scene, with every field individually traceable.
   *
   * The test above names `summary` and `outcome`, which are the two fields somebody
   * thought of. This one marks *every* string on `Scene` and its beats, so adding a
   * `{{goal}}` or a `{{beats}}` slot to `ACTOR_TAKE_PROMPT` tomorrow fails here rather
   * than shipping a cast that has read the script.
   */
  function markedScene(): Scene {
    const base = scene();
    const mark = (field: string): string => `ZQX-${field}-ZQX`;
    return Scene.parse({
      ...base,
      title: mark('title'),
      summary: mark('summary'),
      plannedSummary: mark('plannedSummary'),
      goal: mark('goal'),
      conflict: mark('conflict'),
      outcome: mark('outcome'),
      valueShift: { ...base.valueShift, axis: mark('axis') },
      beats: base.beats.map((beat, index) => ({
        ...beat,
        title: mark(`beatTitle${String(index)}`),
        summary: mark(`beatSummary${String(index)}`),
        plannedSummary: mark(`beatPlanned${String(index)}`),
      })),
    });
  }

  function markersIn(text: string): readonly string[] {
    return [...new Set([...text.matchAll(/ZQX-[A-Za-z0-9]+-ZQX/gu)].map((match) => match[0]))];
  }

  it('leaks no field of the narrator’s scene into any actor prompt, not only the summary', async () => {
    const backend = scriptedBackend();
    const marked = markedScene();
    await new WriteSceneDialogueUseCase(testDeps(backend)).execute(input({ scene: marked }));

    for (const index of [0, 1]) {
      const whole = `${backend.promptAt(index)}
${backend.systemPromptAt(index)}`;
      expect(markersIn(whole), `actor ${String(index)} was shown the script`).toEqual([]);
    }

    // The director does see it, so the absence above is a redaction and not an empty run.
    expect(markersIn(backend.promptAt(2)).length).toBeGreaterThan(6);
  });

  it('does not let one actor’s take reach another actor, only the director', async () => {
    // The actors are called in sequence, so the first take exists by the time the second
    // call is built. Nothing may carry it across: an actor who has read the other take has
    // heard a performance they were not in the room for.
    const secret = 'ZQX-firstTake-ZQX';
    const backend = new FakeStructuredBackend({
      script: [
        respondJson(take(secret)),
        respondJson(take('Nothing to add.')),
        respondJson(directed([line(1, secret, 0), line(2, 'Nothing to add.', 900)])),
      ],
    });
    await new WriteSceneDialogueUseCase(testDeps(backend)).execute(input());

    expect(backend.promptAt(1)).not.toContain(secret);
    expect(backend.systemPromptAt(1)).not.toContain(secret);
    // The director is given every take; that is what reconciliation is.
    expect(backend.promptAt(2)).toContain(secret);
  });

  it("binds each actor to its own voice and to no one else's", async () => {
    const backend = scriptedBackend();
    await new WriteSceneDialogueUseCase(testDeps(backend)).execute(input());

    expect(backend.systemPromptAt(0)).toContain('staccato');
    expect(backend.systemPromptAt(0)).not.toContain('looping');
    expect(backend.systemPromptAt(1)).toContain('looping');
    expect(backend.systemPromptAt(1)).not.toContain('staccato');
  });

  it('resolves ordinals back to entities and orders the scene by time', async () => {
    const backend = scriptedBackend();
    const outcome = await new WriteSceneDialogueUseCase(testDeps(backend)).execute(input());

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.lines.map((entry) => entry.startMs)).toEqual([0, 1_200]);
    expect(outcome.value.lines[0]?.speakerRef).toBe(IDS.mahtab);
    expect(outcome.value.lines[1]?.speakerRef).toBe(IDS.roya);
    // Duration and phonemes are measured from audio that does not exist yet.
    expect(outcome.value.lines[0]?.durationMs).toBeUndefined();
    expect(outcome.value.lines[0]?.phonemes).toEqual([]);
  });

  it("refuses a speaker who was handed somebody else's view - the bug the field exists for", async () => {
    const backend = scriptedBackend();
    const wrong: SceneSpeaker = { ...mahtab(), view: epistemicView(IDS.roya) };
    const outcome = await new WriteSceneDialogueUseCase(testDeps(backend)).execute(
      input({ speakers: [wrong, bijan()] }),
    );

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'epistemic-view-mismatch' });
    expect(backend.callCount).toBe(0);
  });

  it('refuses a scene with nobody in it', async () => {
    const outcome = await new WriteSceneDialogueUseCase(
      testDeps(new FakeStructuredBackend()),
    ).execute(input({ speakers: [] }));
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'no-speakers' });
  });

  it('refuses a directed line attributed to a speaker who is not in the scene', async () => {
    const backend = new FakeStructuredBackend({
      script: [
        respondJson(take('One.')),
        respondJson(take('Two.')),
        respondJson(directed([line(7, 'Who said that?', 0)])),
      ],
    });
    const outcome = await new WriteSceneDialogueUseCase(testDeps(backend)).execute(input());

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'unknown-speaker-ordinal', ordinal: 7 });
  });

  it('reports a speaker whose verbal tics did not survive the director', async () => {
    const backend = new FakeStructuredBackend({
      script: [
        respondJson(take('Aye then, hand me the wick.')),
        respondJson(take('As it happens, there is a thing about that boat.')),
        respondJson(
          directed([
            // Mahtab's "aye then" has been smoothed away; Bijan's tic survives.
            line(1, 'Hand me the wick, please.', 0),
            line(2, 'As it happens, there is a thing about that boat.', 900),
          ]),
        ),
      ],
    });
    const outcome = await new WriteSceneDialogueUseCase(testDeps(backend)).execute(input());

    if (isErr(outcome)) throw new Error(outcome.error.message);
    const findings = Object.fromEntries(
      outcome.value.voiceFindings.map((finding) => [finding.name, finding]),
    );
    expect(findings.Mahtab?.flattened).toBe(true);
    expect(findings.Bijan?.flattened).toBe(false);
    expect(findings.Bijan?.retainedTics).toEqual(['as it happens']);
  });

  it('gives up as a Result when an actor call cannot be served', async () => {
    const backend = new FakeStructuredBackend({ script: [respondError(), respondError()] });
    const outcome = await new WriteSceneDialogueUseCase(testDeps(backend)).execute(input());
    expect(isErr(outcome)).toBe(true);
  });

  it('gives up as a Result when the director call cannot be served', async () => {
    const backend = new FakeStructuredBackend({
      script: [respondJson(take('One.')), respondJson(take('Two.')), respondError()],
    });
    const outcome = await new WriteSceneDialogueUseCase(testDeps(backend)).execute(input());
    expect(isErr(outcome)).toBe(true);
  });

  it('shows the director every take, its subtext and what each actor withheld', async () => {
    const backend = scriptedBackend();
    await new WriteSceneDialogueUseCase(testDeps(backend)).execute(input());

    const directorPrompt = backend.userPromptAt(2);
    expect(directorPrompt).toContain('Speaker 1: Mahtab');
    expect(directorPrompt).toContain('Speaker 2: Bijan');
    expect(directorPrompt).toContain('How long he has known.');
    expect(directorPrompt).toContain('tics: aye then');
  });
});

describe('renderEpistemicBriefing', () => {
  it('separates certainty from error from suspicion', () => {
    const view = epistemicView(IDS.mahtab, {
      knows: [knownFact('The lamp is out.')],
      believesFalsely: [knownFact('Her daughter drowned in the storm.', { via: 'told' })],
      suspects: [knownFact('Someone else was on the boat.', { via: 'suspects', confidence: 0.4 })],
    });
    const text = renderEpistemicBriefing(view, 'Mahtab');

    expect(text).toContain('What they know to be true');
    expect(text).toContain('and are wrong about');
    expect(text).toContain('What they suspect');
    expect(text).toContain('only half believes it');
    expect(text).toContain('This is the whole of what Mahtab knows');
  });

  it('never renders a blind spot, whatever else is in the view', () => {
    const view = epistemicView(IDS.mahtab, {
      knows: [knownFact('The lamp is out.')],
      blindSpots: [IDS.relationOne, IDS.relationTwo],
      factCount: 9,
    });
    const text = renderEpistemicBriefing(view, 'Mahtab');
    expect(text).not.toContain(IDS.relationOne);
    expect(text).not.toContain(IDS.relationTwo);
  });

  it('says the knowledge is partial when the view was capped', () => {
    const text = renderEpistemicBriefing(
      epistemicView(IDS.mahtab, { truncated: true, factCount: 600 }),
      'Mahtab',
    );
    expect(text).toContain('incomplete');
    expect(text).toContain('600');
  });

  it('names the empty case rather than leaving a blank heading', () => {
    const text = renderEpistemicBriefing(epistemicView(IDS.mahtab), 'Mahtab');
    expect(text).toContain('nothing relevant to this scene');
  });

  it('says who a second-hand fact came from', () => {
    const text = renderEpistemicBriefing(
      epistemicView(IDS.mahtab, {
        knows: [
          knownFact('The harbourmaster lied.', {
            via: 'told',
            learnedFrom: IDS.roya,
            learnedAt: { ordinal: 40, label: 'the second thaw' },
          }),
        ],
      }),
      'Mahtab',
    );
    expect(text).toContain('told it from someone');
    expect(text).toContain('the second thaw');
  });
});

describe('resolveSpeakers and checkTicRetention', () => {
  it('reports no findings for a speaker with no tics on their sheet', () => {
    const plain = castMember('Plain', IDS.mahtab, {
      voice: { ...castMember('x', IDS.mahtab).payload.voice, verbalTics: [] },
    });
    const speaker: SceneSpeaker = {
      member: plain,
      view: epistemicView(IDS.mahtab),
      objective: 'nothing',
    };
    const resolved = resolveSpeakers([line(1, 'Something.', 0)] as never, [speaker]);
    if (isErr(resolved)) throw new Error('should resolve');
    expect(checkTicRetention(resolved.value, [speaker])[0]?.flattened).toBe(false);
  });
});
