/**
 * The rule with teeth: **a provider may never be consulted at evaluation time.**
 *
 * ADR-0008 §1 makes providers safe by putting them *outside* the determinism boundary
 * and the IR *on* it. That trade only holds while `evaluate(ir, t)` calls nothing: the
 * moment it consults a provider, a frame depends on something that is not in the
 * document, and bit-reproducible renders, resumable renders, sharded renders and sprite
 * sheets that match live playback all stop being true at once - silently, because the
 * first provider anyone would wire in would be a deterministic one and it would work.
 *
 * Two tests, because either alone is escapable:
 *
 *  - A **static** one that walks the evaluator's import closure. It fails on the line
 *    that would introduce the dependency, before anything is called, and it catches the
 *    lazy-import and call-it-only-sometimes variants that a behavioural test misses.
 *  - A **behavioural** one that hands the evaluator a document authored by providers
 *    that then explode if touched. It catches an injected provider - something reached
 *    through an argument rather than an import, which the static test cannot see.
 *
 * The third guard needs no test: `author` returns a `Promise` and `evaluate` is
 * synchronous, so consulting a provider from inside it does not compile.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';
import { AnimationIR, MotionRequest, type AuthoredMotion, type NodeId } from '@rv/contracts';
import { InternalError, type AppError, type Result } from '@rv/shared-kernel';

import { evaluate } from '../evaluate';
import { KeyframeMotionProvider } from './keyframe-provider';
import type { MotionProvider } from './port';
import { ProceduralMotionProvider } from './procedural-provider';
import { MotionProviderRegistry } from './registry';

const SRC = resolve(import.meta.dirname, '..');
const IMPORT_FROM = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g;

/** Every file `entry` reaches through a relative import, transitively. */
function importClosure(entry: string): readonly string[] {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_FROM)) {
      const specifier = match[1];
      if (specifier?.startsWith('.') !== true) continue;
      queue.push(`${resolve(dirname(file), specifier)}.ts`);
    }
  }

  return [...seen].map((file) => relative(SRC, file).split(sep).join('/'));
}

describe('evaluate() does not reach a motion provider', () => {
  const closure = importClosure(join(SRC, 'evaluate.ts'));

  it('reaches the pure evaluation modules and nothing else', () => {
    // Spelled as an exact set rather than a "does not contain" so that the day someone
    // adds a dependency here, the test says which one.
    expect([...closure].sort()).toEqual([
      'behaviours.ts',
      'easing.ts',
      'evaluate.ts',
      'noise.ts',
      'track.ts',
      'transform.ts',
    ]);
  });

  it('never reaches the provider registry, the port or an implementation', () => {
    expect(closure.filter((file) => file.startsWith('motion/'))).toEqual([]);
  });

  it('never reaches the clip library either, which is authoring-time work', () => {
    // Retargeting rewrites a document *before* it is evaluated. An evaluator that could
    // retarget would be an evaluator whose output depended on a second rig.
    expect(closure.filter((file) => file.startsWith('clips/') || file.startsWith('rig/'))).toEqual(
      [],
    );
  });
});

describe('evaluating a provider-authored document consults nobody', () => {
  const NODE: NodeId = `nod_${'0'.repeat(24)}A1`;

  /** A registry of providers that fail loudly if anything calls them. */
  function poisoned(): MotionProviderRegistry {
    const registry = new MotionProviderRegistry();
    const explode = (id: string, kind: MotionProvider['kind']): MotionProvider => ({
      id,
      kind,
      capabilities: { channels: ['rotation'], behaviours: ['wind'] },
      author(): Promise<Result<AuthoredMotion, AppError>> {
        throw new InternalError({ message: `${id} was consulted at evaluation time` });
      },
    });
    registry.register(explode('booby-trapped-keyframe', 'keyframe'));
    registry.register(explode('booby-trapped-procedural', 'procedural'));
    return registry;
  }

  async function authoredIr(): Promise<AnimationIR> {
    const keyframes = await new KeyframeMotionProvider().author(
      MotionRequest.parse({
        kind: 'keyframe',
        key: 'sway-in',
        curves: [
          {
            nodeId: NODE,
            channel: 'position.x',
            keys: [
              { timeMs: 0, value: 0 },
              { timeMs: 800, value: 120 },
            ],
          },
        ],
      }),
    );
    const procedural = await new ProceduralMotionProvider().author(
      MotionRequest.parse({
        kind: 'procedural',
        key: 'sway-in',
        seed: 3,
        nodeIds: [NODE],
        plans: [{ kind: 'wind' }, { kind: 'breathe' }],
      }),
    );
    if (!keyframes.ok || !procedural.ok) throw new Error('fixture');

    return AnimationIR.parse({
      irVersion: 1,
      id: `anm_${'0'.repeat(24)}A1`,
      name: 'authored by providers',
      fps: 24,
      durationMs: 1000,
      sceneSpace: { width: 1920, height: 1080 },
      seed: 3,
      nodes: [{ kind: 'group', id: NODE, name: 'subject', parentId: null }],
      tracks: keyframes.value.tracks,
      behaviours: procedural.value.behaviours,
      markers: [],
    });
  }

  it('evaluates a fully provider-authored IR without touching a provider', async () => {
    // The registry is live and every provider in it throws. Nothing calls one, because
    // the motion is *in the document*: that is the whole of the trade ADR-0008 makes.
    const registry = poisoned();
    const ir = await authoredIr();

    expect(registry.providers()).toHaveLength(2);
    for (let timeMs = 0; timeMs <= 1000; timeMs += 17) {
      expect(() => evaluate(ir, timeMs)).not.toThrow();
    }
  });

  it('is still bit-identical on a second pass, which is what "the artefact replays" means', async () => {
    const ir = await authoredIr();
    expect(evaluate(ir, 421)).toEqual(evaluate(ir, 421));
  });

  it('proves the poisoned registry really would have exploded', async () => {
    // A test that passes because the trap was never armed is not a test.
    const registry = poisoned();
    const provider = registry.get('booby-trapped-procedural');
    expect(provider).toBeDefined();
    await expect(async () =>
      provider?.author(
        MotionRequest.parse({
          kind: 'procedural',
          key: 'x',
          seed: 1,
          nodeIds: [NODE],
          plans: [{ kind: 'wind' }],
        }),
      ),
    ).rejects.toThrow(/consulted at evaluation time/);
  });
});
