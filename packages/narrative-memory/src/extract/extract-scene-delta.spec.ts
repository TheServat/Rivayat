import { describe, expect, it } from 'vitest';
import { FixedClock, instant, isErr, isOk } from '@rv/shared-kernel';
import { Relation, StateDelta } from '@rv/contracts';

import { ARIA, KAEL, KEEP, SWORD, VALE, episodeOrdinal, valeGraph } from '../__fixtures__/vale';
import { episodeId, sceneId, storyTime } from '../__fixtures__/builders';
import { FakeStructuredBackend } from '../__fixtures__/fakes';
import { ExtractSceneDeltaUseCase } from './extract-scene-delta';

const CLOCK = new FixedClock(instant(Date.parse('2026-06-01T00:00:00.000Z')));
const EPISODE = episodeId('e06');
const SCENE = sceneId('e06s01');

const SCENE_TEXT = [
  'Aria hands Kael the sword and walks out of the Vale toward the Keep.',
  'Kael learns that Aria is his mother.',
].join('\n');

function extractor(backend: FakeStructuredBackend): ExtractSceneDeltaUseCase {
  return new ExtractSceneDeltaUseCase({ backends: [backend], clock: CLOCK });
}

function baseInput(): Parameters<ExtractSceneDeltaUseCase['execute']>[0] {
  return {
    graph: valeGraph(),
    sceneId: SCENE,
    episodeId: EPISODE,
    at: storyTime(episodeOrdinal(6)),
    sceneText: SCENE_TEXT,
    presentEntityIds: [KAEL, ARIA],
  };
}

const FULL_OBSERVATION = {
  entities: [
    { mention: 'the ledger', kind: 'prop', importance: 'recurring', summary: 'A tallied book.' },
  ],
  relations: [
    {
      subject: 'Aria',
      object: 'Kael',
      type: 'mentor-of',
      fact: 'Aria has been teaching Kael the ledger.',
      strength: 0.4,
    },
    {
      subject: 'Kael',
      object: 'the ledger',
      type: 'owns',
      fact: 'Kael owns the ledger now.',
    },
  ],
  movements: [{ subject: 'Aria', from: 'the Vale', to: 'the Keep' }],
  possessions: [{ item: 'the sword', from: 'Aria', to: 'Kael', mode: 'given' }],
  knowledge: [
    {
      knower: 'Kael',
      change: 'learned',
      about: 'Aria',
      proposition: 'Aria is my mother.',
      learnedFrom: 'Aria',
    },
  ],
  vitality: [],
  setups: [
    {
      setup: 'The ledger has a page torn out.',
      promise: 'The audience expects to learn what was on the torn page.',
      involves: ['the ledger', 'Kael'],
      urgency: 0.8,
    },
  ],
};

describe('ExtractSceneDeltaUseCase', () => {
  it('turns names into ids and produces a delta that parses', async () => {
    const backend = new FakeStructuredBackend([FULL_OBSERVATION]);
    const result = await extractor(backend).execute(baseInput());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const { delta } = result.value;

    expect(StateDelta.safeParse(delta).success).toBe(true);
    expect(delta.positionChanges).toEqual([{ entityId: ARIA, from: VALE, to: KEEP }]);
    expect(delta.possessionChanges).toEqual([
      { itemId: SWORD, from: ARIA, to: KAEL, mode: 'given' },
    ]);
    expect(result.value.unresolved).toEqual([]);
  });

  it('never asks the model for an identifier', async () => {
    const backend = new FakeStructuredBackend([FULL_OBSERVATION]);
    await extractor(backend).execute(baseInput());
    expect(backend.lastPrompt).toContain('Never invent an');
    // The prompt names the cast, so the model has the spellings to use.
    expect(backend.lastPrompt).toContain('Kael');
    expect(backend.lastPrompt).not.toContain(KAEL);
  });

  it('mints an id for an entity the scene introduced and lets the same scene refer to it', async () => {
    const backend = new FakeStructuredBackend([FULL_OBSERVATION]);
    const result = await extractor(backend).execute(baseInput());
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const ledger = result.value.introduced.find((entity) => entity.mention === 'the ledger');
    expect(ledger).toBeDefined();
    expect(result.value.delta.entitiesIntroduced).toEqual([ledger?.entityId]);
    // The relation asserted about it in the same payload resolved to the minted id.
    const owns = result.value.relations.find((relation) => relation.type === 'owns');
    expect(owns?.to).toBe(ledger?.entityId);
  });

  it('emits relations with story time from the scene and authoring time from the clock', async () => {
    const backend = new FakeStructuredBackend([FULL_OBSERVATION]);
    const result = await extractor(backend).execute(baseInput());
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    for (const relation of result.value.relations) {
      expect(Relation.safeParse(relation).success).toBe(true);
      expect(relation.validFrom?.ordinal).toBe(episodeOrdinal(6));
      expect(relation.validUntil).toBeNull();
      expect(relation.assertedAt).toBe('2026-06-01T00:00:00.000Z');
      expect(relation.sourceRef).toEqual({ kind: 'episode', episodeId: EPISODE, sceneId: SCENE });
    }
  });

  it('records a knowledge change for every epistemic edge it minted', async () => {
    const backend = new FakeStructuredBackend([FULL_OBSERVATION]);
    const result = await extractor(backend).execute(baseInput());
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const learned = result.value.delta.knowledgeChanges.find(
      (change) => change.change === 'learned',
    );
    expect(learned?.knowerId).toBe(KAEL);
    expect(learned?.learnedFrom).toBe(ARIA);
    // The change points at the edge it opened, so a later reveal can bound that row.
    const edge = result.value.relations.find(
      (relation) => relation.id === learned?.aboutRelationId,
    );
    expect(edge?.type).toBe('knows');
    expect(edge?.from).toBe(KAEL);
    expect(edge?.to).toBe(ARIA);
  });

  it('treats an epistemic relation as a change to somebody‘s model of the world', async () => {
    const backend = new FakeStructuredBackend([
      {
        relations: [
          {
            subject: 'Kael',
            object: 'the fire',
            type: 'believes-falsely',
            fact: 'Kael believes his parents died in the fire.',
          },
        ],
      },
    ]);
    const result = await extractor(backend).execute(baseInput());
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.delta.knowledgeChanges).toHaveLength(1);
    expect(result.value.delta.knowledgeChanges[0]?.change).toBe('learned');
    expect(result.value.relations[0]?.type).toBe('believes-falsely');
  });

  it('surfaces an unresolvable mention instead of dropping the observation', async () => {
    const backend = new FakeStructuredBackend([
      {
        relations: [
          {
            subject: 'Someone Nobody Named',
            object: 'Kael',
            type: 'resents',
            fact: 'A stranger resents Kael.',
          },
        ],
      },
    ]);
    const result = await extractor(backend).execute(baseInput());
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.relations).toHaveLength(0);
    expect(result.value.delta.relationsAsserted).toHaveLength(0);
    expect(result.value.unresolved).toEqual([
      {
        mention: 'Someone Nobody Named',
        reason: 'unknown',
        candidates: [],
        where: 'relations.subject',
      },
    ]);
  });

  it('matches a retraction to the standing edge it ends', async () => {
    const graph = valeGraph();
    const backend = new FakeStructuredBackend([
      {
        relations: [
          {
            subject: 'Kael',
            object: 'the Vale',
            type: 'located-in',
            fact: 'Kael is in the Vale.',
            polarity: 'retracted',
          },
        ],
      },
    ]);
    const result = await extractor(backend).execute({ ...baseInput(), graph });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const standing = graph.relations.find((relation) => relation.fact === 'Kael is in the Vale.');
    expect(result.value.delta.relationsRetracted).toEqual([standing?.id]);
  });

  it('reports a retraction against an edge nobody holds', async () => {
    const backend = new FakeStructuredBackend([
      {
        relations: [
          {
            subject: 'Kael',
            object: 'the Keep',
            type: 'located-in',
            fact: 'Kael is in the Keep.',
            polarity: 'retracted',
          },
        ],
      },
    ]);
    const result = await extractor(backend).execute(baseInput());
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.delta.relationsRetracted).toEqual([]);
    expect(result.value.unmatchedRetractions).toHaveLength(1);
    expect(result.value.unmatchedRetractions[0]?.subjectId).toBe(KAEL);
  });

  it('plants a promise with its entities resolved', async () => {
    const backend = new FakeStructuredBackend([FULL_OBSERVATION]);
    const result = await extractor(backend).execute(baseInput());
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const [loop] = result.value.openLoops;
    expect(loop?.status).toBe('open');
    expect(loop?.urgency).toBe(0.8);
    expect(loop?.plantedIn).toEqual({ episodeId: EPISODE, sceneId: SCENE });
    expect(loop?.entities).toContain(KAEL);
    expect(result.value.delta.openLoopsPlanted).toEqual([loop?.id]);
  });

  it('records a death', async () => {
    const backend = new FakeStructuredBackend([
      { vitality: [{ subject: 'Aria', to: 'dead', note: 'The stairwell.' }] },
    ]);
    const result = await extractor(backend).execute(baseInput());
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.delta.vitalityChanges).toEqual([
      { entityId: ARIA, to: 'dead', note: 'The stairwell.' },
    ]);
  });

  it('refuses empty scene text before spending anything', async () => {
    const backend = new FakeStructuredBackend([FULL_OBSERVATION]);
    const result = await extractor(backend).execute({ ...baseInput(), sceneText: '   ' });
    expect(isErr(result)).toBe(true);
    expect(backend.callCount).toBe(0);
  });

  it('propagates a backend failure', async () => {
    const backend = new FakeStructuredBackend();
    const result = await extractor(backend).execute(baseInput());
    expect(isErr(result)).toBe(true);
  });

  it('is deterministic: the same scene extracted twice mints the same ids', async () => {
    const first = await extractor(new FakeStructuredBackend([FULL_OBSERVATION])).execute(
      baseInput(),
    );
    const second = await extractor(new FakeStructuredBackend([FULL_OBSERVATION])).execute(
      baseInput(),
    );
    expect(isOk(first) && isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(second.value.delta).toStrictEqual(first.value.delta);
    expect(second.value.relations).toStrictEqual(first.value.relations);
  });

  it('works without a present-entity hint', async () => {
    const backend = new FakeStructuredBackend([FULL_OBSERVATION]);
    const input = baseInput();
    delete (input as { presentEntityIds?: unknown }).presentEntityIds;
    const result = await extractor(backend).execute({
      ...input,
      at: storyTime(episodeOrdinal(6), 'the sixth thaw'),
    });
    expect(isOk(result)).toBe(true);
    expect(backend.lastPrompt).toContain('the sixth thaw');
  });
});
