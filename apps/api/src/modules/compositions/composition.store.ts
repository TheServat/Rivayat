/**
 * Compositions on disk, addressed by their own content.
 *
 * One JSON file per composition under `<workspace>/compositions/<sha256>.json`, which is
 * the same shape as every other stopgap store in this app and the same shape the render
 * checkpoint uses - and here it is not a stopgap at all, it is the design. A composition
 * *is* its bytes: storing it under a mutable id would let a run's reference point at
 * something else later, which is exactly what ADR-0001 forbids.
 *
 * Storing the same composition twice is therefore free and idempotent. That is not an
 * optimisation, it is what makes the studio's "render this again" button safe: the
 * second store returns the first id, and the render finds the first render's frames.
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AnimationIR, type Label } from '@rv/contracts';
import {
  ValidationError,
  contentHash,
  err,
  isErr,
  ok,
  toAppError,
  toIso,
  type AppError,
  type Clock,
  type Logger,
  type Result,
} from '@rv/shared-kernel';

import {
  CompositionSummary,
  StoredComposition,
  type CompositionList,
} from './compositions.contracts';

export interface CompositionStoreOptions {
  readonly workspaceDir: string;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class CompositionStore {
  readonly #directory: string;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(options: CompositionStoreOptions) {
    this.#directory = join(options.workspaceDir, 'compositions');
    this.#clock = options.clock;
    this.#logger = options.logger.child({ component: 'compositions' });
  }

  /** Idempotent: the same composition stored twice is the same composition. */
  async store(ir: AnimationIR, label?: Label): Promise<Result<CompositionSummary, AppError>> {
    const id = contentHash(ir);

    const existing = await this.find(id);
    if (isErr(existing)) return existing;
    if (existing.value !== null) return ok(existing.value.summary);

    const summary = CompositionSummary.parse({
      id,
      animationId: ir.id,
      label: label ?? ir.name,
      durationMs: ir.durationMs,
      fps: ir.fps,
      sceneSpace: ir.sceneSpace,
      nodeCount: ir.nodes.length,
      storedAt: toIso(this.#clock.now()),
    });

    const written = await this.#write(id, { summary, ir });
    return isErr(written) ? written : ok(summary);
  }

  async find(id: string): Promise<Result<StoredComposition | null, AppError>> {
    let raw: string;
    try {
      raw = await readFile(this.#path(id), 'utf8');
    } catch {
      return ok(null);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (caught: unknown) {
      return err(
        new ValidationError({
          message: `The stored composition ${id} is not readable`,
          cause: caught,
          context: { id },
        }),
      );
    }

    // Parsed, not cast. A composition written by an older build must fail loudly rather
    // than reach the renderer as half a document.
    const document = StoredComposition.safeParse(parsed);
    return document.success
      ? ok(document.data)
      : err(
          new ValidationError({
            message: `The stored composition ${id} no longer satisfies the schema`,
            context: { id, issues: document.error.issues.map((issue) => issue.path.join('.')) },
          }),
        );
  }

  /**
   * Every stored composition, newest first.
   *
   * Summaries only: the list screen shows tens of rows and each IR is megabytes. A
   * document that no longer parses is reported and skipped, so one bad file does not
   * take the list with it.
   */
  async list(): Promise<Result<CompositionList, AppError>> {
    let names: readonly string[];
    try {
      names = await readdir(this.#directory);
    } catch {
      // Absent is the normal state on a fresh workspace.
      return ok({ compositions: [] });
    }

    const summaries: CompositionSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const found = await this.find(name.slice(0, -'.json'.length));
      if (isErr(found)) {
        this.#logger.warn('stored composition skipped', { file: name, code: found.error.code });
        continue;
      }
      if (found.value !== null) summaries.push(found.value.summary);
    }

    summaries.sort((left, right) => (left.storedAt < right.storedAt ? 1 : -1));
    return ok({ compositions: summaries });
  }

  async #write(id: string, document: StoredComposition): Promise<Result<void, AppError>> {
    const prepared = await this.#attempt(mkdir(this.#directory, { recursive: true }));
    if (isErr(prepared)) return prepared;

    // Temp file then rename, like every other durable write here: a composition
    // truncated by a `ctrl-c` would be a render of half a film.
    const path = this.#path(id);
    const staging = `${path}.tmp`;
    const written = await this.#attempt(writeFile(staging, JSON.stringify(document), 'utf8'));
    if (isErr(written)) return written;
    return this.#attempt(rename(staging, path));
  }

  async #attempt(work: Promise<unknown>): Promise<Result<void, AppError>> {
    try {
      await work;
      return ok(undefined);
    } catch (caught: unknown) {
      return err(toAppError(caught, 'could not write the composition'));
    }
  }

  #path(id: string): string {
    // A content hash is already filename-safe; the replacement guards a caller that
    // hands over something else.
    return join(this.#directory, `${id.replaceAll(/[^\w.-]/g, '_')}.json`);
  }
}
