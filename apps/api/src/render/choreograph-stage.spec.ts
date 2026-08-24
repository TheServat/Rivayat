/**
 * The joint: a payload becomes a stored composition and a record beside it.
 *
 * The compile itself is tested in `choreograph.use-case.spec.ts`. What is left here is
 * everything the use case cannot do - store, address, and tell the rest of the run what
 * it made - plus the refusal, which is the only thing S8 can fail on that is not the
 * shot list's fault.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FixedClock, MemoryLogger, instant, isErr } from '@rv/shared-kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CompositionStore } from '../modules/compositions/composition.store';
import { ChoreographStageHandler, defaultMotionProviders } from './choreograph-stage.handler';
import { ChoreographyStore } from './choreography.store';
import { COMPOSITION_ARTIFACT_PREFIX } from './composition-source';
import { shot, shotId } from './__fixtures__/shots';
import { stageContext } from './__fixtures__/stage';

describe('ChoreographStageHandler', () => {
  let workspace = '';

  function stores(): { compositions: CompositionStore; choreography: ChoreographyStore } {
    return {
      compositions: new CompositionStore({
        workspaceDir: workspace,
        clock: new FixedClock(instant(0)),
        logger: new MemoryLogger(),
      }),
      choreography: new ChoreographyStore(workspace),
    };
  }

  function handler(): ChoreographStageHandler {
    return new ChoreographStageHandler({
      ...stores(),
      motion: defaultMotionProviders(),
      clock: new FixedClock(instant(1_760_000_000_000)),
      logger: new MemoryLogger(),
    });
  }

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'rivayat-choreo-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('stores the composition and tells the run where it is', async () => {
    const harness = stageContext({
      stage: 'choreograph',
      payload: { choreograph: { shots: [shot(), shot({ id: shotId('0B'), index: 1 })] } },
    });

    const outcome = await handler().execute(harness.context);
    if (isErr(outcome)) throw outcome.error;

    const reference = outcome.value.artifacts.find((artifact) =>
      artifact.startsWith(COMPOSITION_ARTIFACT_PREFIX),
    );
    expect(reference).toBeDefined();
    if (reference === undefined) return;

    // The artefact is the address, and the address resolves: this is the whole seam
    // between S8 and S9/S10/S11, which have no other way to learn what S8 made.
    const id = reference.slice(COMPOSITION_ARTIFACT_PREFIX.length);
    const stored = await stores().compositions.find(id);
    if (isErr(stored)) throw stored.error;
    expect(stored.value?.ir.durationMs).toBe(4000);
    expect(outcome.value.artifacts).toContain('shots:2');
    // S8 produces no video, so it must not claim any.
    expect(outcome.value.deliveredMs).toBeUndefined();
  });

  it('files the shot list beside the composition, because the IR cannot hold it', async () => {
    const harness = stageContext({
      stage: 'choreograph',
      payload: { choreograph: { shots: [shot()] } },
    });

    const outcome = await handler().execute(harness.context);
    if (isErr(outcome)) throw outcome.error;
    const id = (outcome.value.artifacts[0] ?? '').slice(COMPOSITION_ARTIFACT_PREFIX.length);

    const record = await stores().choreography.find(id);
    if (isErr(record)) throw record.error;
    expect(record.value?.shots).toHaveLength(1);
    expect(record.value?.shots[0]?.startMs).toBe(0);
    // The subject the reframer will follow, resolved to a node that exists in the IR.
    expect(record.value?.shots[0]?.focusNodeId).toMatch(/^nod_/);
    expect(record.value?.compositionId).toBe(id);
  });

  it('is idempotent: choreographing the same cut twice stores it once', async () => {
    const payload = { choreograph: { shots: [shot()] } };
    const first = await handler().execute(stageContext({ stage: 'choreograph', payload }).context);
    const second = await handler().execute(stageContext({ stage: 'choreograph', payload }).context);
    if (isErr(first) || isErr(second)) throw new Error('the stage failed');

    expect(second.value.artifacts).toEqual(first.value.artifacts);
  });

  it('refuses a run that reached S8 with no shots, naming the field', async () => {
    const harness = stageContext({ stage: 'choreograph', payload: {} });
    const outcome = await handler().execute(harness.context);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
    expect(JSON.stringify(outcome.error.context)).toContain('run.payload.choreograph');
  });

  it('declares itself implemented, which is what the health endpoint reads', () => {
    expect(handler().implemented).toBe(true);
    expect(handler().stage).toBe('choreograph');
  });
});
