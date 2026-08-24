/**
 * Reading back what a run delivered.
 *
 * The manifest is written by S10 next to the artefacts it describes, under the render's
 * content address. So this is a lookup with one indirection: the run's `render` stage
 * recorded a `render-key:` artefact, and the key names the directory.
 *
 * The indirection is the point rather than an accident of storage. Keying by the run
 * would mean a resumed run, a re-run of the same cut, and a new run over an edited
 * payload all had to be reconciled by hand; keying by content means the run that asks is
 * pointed at the manifest for the bytes it actually produced, whoever produced them.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { RunId } from '@rv/contracts';
import { NotFoundError, err, isErr, ok, type AppError, type Result } from '@rv/shared-kernel';

import type { RunRepository } from '../application/ports/repository.ports';
import type { RunSummary } from '../application/resources';
import { RunDelivery } from './delivery.contracts';
import { renderLayout } from './render-stage.handler';

/** `render-key:<sha256>` on the render stage's artefact list. */
const RENDER_KEY_PREFIX = 'render-key:';

export interface DeliveryServiceDeps {
  readonly runs: RunRepository;
  readonly workspaceDir: string;
}

export class DeliveryService {
  readonly #runs: RunRepository;
  readonly #workspaceDir: string;

  constructor(deps: DeliveryServiceDeps) {
    this.#runs = deps.runs;
    this.#workspaceDir = deps.workspaceDir;
  }

  async forRun(runId: RunId): Promise<Result<RunDelivery, AppError>> {
    const found = await this.#runs.findById(runId);
    if (isErr(found)) return found;
    if (found.value === null) return err(new NotFoundError('run', runId));

    const key = renderKeyOf(found.value);
    if (key === null) {
      // A 404 for the *delivery*, not for the run: a run that has not rendered has no
      // files, and saying so is different from saying the run does not exist.
      return err(
        new NotFoundError('delivery', runId, {
          context: { reason: 'this run has not completed a render stage' },
        }),
      );
    }

    // The codec is not on the run, and the manifest's name does not depend on it.
    const layout = renderLayout(this.#workspaceDir, key, 'h264');
    if (!existsSync(layout.manifest)) {
      return err(
        new NotFoundError('delivery', runId, {
          context: { renderKey: key, reason: 'the render produced no manifest' },
        }),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(layout.manifest, 'utf8'));
    } catch (caught: unknown) {
      return err(
        new NotFoundError('delivery', runId, {
          cause: caught,
          context: { renderKey: key, reason: 'the manifest is not readable' },
        }),
      );
    }

    // Parsed, not cast. A manifest written by an older build must fail here rather than
    // reach a screen that renders half a card and a blank verdict.
    const manifest = RunDelivery.safeParse(parsed);
    return manifest.success
      ? ok(manifest.data)
      : err(
          new NotFoundError('delivery', runId, {
            context: {
              renderKey: key,
              issues: manifest.error.issues.map((issue) => issue.path.join('.')),
            },
          }),
        );
  }
}

/**
 * The render key a run recorded, or `null` if it never finished one.
 *
 * Both stages that know a render key record it. S10 records the render it produced;
 * S11 records the render it *cut from*, which is the only way a delivery-only run - a
 * re-delivery of a master rendered last week, which is a legitimate thing to ask for -
 * can answer "what did you produce". Searching for the artefact rather than for a
 * particular stage is also what keeps this from needing a change when a third stage
 * files something under the same address.
 */
export function renderKeyOf(run: RunSummary): string | null {
  let found: string | null = null;
  for (const stage of run.stages) {
    if (stage.status !== 'succeeded') continue;
    if (stage.stage !== 'render' && stage.stage !== 'deliver') continue;
    const artifact = stage.artifacts.find((ref) => ref.startsWith(RENDER_KEY_PREFIX));
    // The later stage wins: a run that rendered and then delivered has one key, and a
    // run that delivered a different master than it rendered delivered *that* one.
    if (artifact !== undefined) found = artifact.slice(RENDER_KEY_PREFIX.length);
  }
  return found;
}
