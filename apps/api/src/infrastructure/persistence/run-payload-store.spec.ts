/**
 * The store that decides whether a killed run can be resumed at all.
 *
 * A run whose payload died with its worker is not resumable - there is nothing to re-run
 * it *with*, and guessing an empty payload would drive every stage against inputs nobody
 * chose. So the two failure modes here are the whole point: a payload that was never
 * written (a run from an older build) must read as "absent", and a payload that was
 * written badly must read as an error rather than as a plausible-looking half-object.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunId } from '@rv/contracts';
import { MemoryLogger, isErr } from '@rv/shared-kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonFileRunPayloadStore } from './json-file-run-payload.store';

const RUN = 'run_01J0000000000000000000000A' as RunId;

describe('JsonFileRunPayloadStore', () => {
  let workspace = '';
  let store: JsonFileRunPayloadStore;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'rivayat-payload-'));
    store = new JsonFileRunPayloadStore({ workspaceDir: workspace, logger: new MemoryLogger() });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('round-trips a payload across two instances, which is the whole point', async () => {
    const payload = { render: { ir: { irVersion: 1 }, codec: 'h264' }, note: 'first run' };
    expect(isErr(await store.save(RUN, payload))).toBe(false);

    // A second instance stands in for a second process: the first one is dead.
    const reopened = new JsonFileRunPayloadStore({
      workspaceDir: workspace,
      logger: new MemoryLogger(),
    });
    const loaded = await reopened.load(RUN);
    if (isErr(loaded)) throw loaded.error;
    expect(loaded.value).toEqual(payload);
  });

  it('answers null for a run that never saved one, rather than failing', async () => {
    // A run started by a build that did not save payloads. The caller reports that as a
    // refusal to resume; it is not a corruption.
    const loaded = await store.load(RUN);
    if (isErr(loaded)) throw loaded.error;
    expect(loaded.value).toBeNull();
  });

  it('overwrites cleanly, leaving no temporary file behind', async () => {
    await store.save(RUN, { attempt: 1 });
    await store.save(RUN, { attempt: 2 });

    const entries = await readdir(join(workspace, 'runs'));
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(entries).toHaveLength(1);

    const loaded = await store.load(RUN);
    if (isErr(loaded)) throw loaded.error;
    expect(loaded.value).toEqual({ attempt: 2 });
  });

  it('refuses a payload that is not readable JSON', async () => {
    // What a non-atomic writer leaves when it is killed. Reading half an `AnimationIR`
    // and rendering half a composition is worse than refusing.
    await store.save(RUN, { attempt: 1 });
    const entries = await readdir(join(workspace, 'runs'));
    await writeFile(join(workspace, 'runs', entries[0] ?? ''), '{"render": {"ir"', 'utf8');

    const loaded = await store.load(RUN);
    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.kind).toBe('validation');
  });

  it('refuses a payload that parses but is not an object', async () => {
    await store.save(RUN, { attempt: 1 });
    const entries = await readdir(join(workspace, 'runs'));
    // An array parses fine and spreads into nothing useful; a stage would see no fields
    // and report that its inputs were missing, which is a diagnosis of the wrong thing.
    await writeFile(join(workspace, 'runs', entries[0] ?? ''), '[1, 2, 3]', 'utf8');

    const loaded = await store.load(RUN);
    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.kind).toBe('validation');
  });

  it('reports a write it could not make', async () => {
    const blocked = join(workspace, 'blocked');
    await writeFile(blocked, 'not a directory', 'utf8');

    const store2 = new JsonFileRunPayloadStore({
      workspaceDir: blocked,
      logger: new MemoryLogger(),
    });
    const saved = await store2.save(RUN, { attempt: 1 });
    // Reported rather than swallowed: a run whose payload did not persist cannot be
    // resumed, and the caller refuses to start it rather than discovering that later.
    expect(isErr(saved)).toBe(true);
  });
});
