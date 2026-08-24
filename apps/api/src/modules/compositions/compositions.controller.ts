/**
 * The composition library: what the studio can start a render from.
 *
 * Three routes and no cleverness. The interesting decision is in
 * `compositions.contracts.ts` - identity is the content hash - and everything here
 * follows from it: storing twice is idempotent, and a reference cannot go stale.
 */

import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { NotFoundError, err, isErr, ok, type Result } from '@rv/shared-kernel';

import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { COMPOSITION_STORE } from '../../tokens';
import type { CompositionStore } from './composition.store';
import {
  CompositionIdParam,
  StoreCompositionBody,
  type CompositionList,
  type CompositionSummary,
  type StoredComposition,
} from './compositions.contracts';

@Controller('compositions')
export class CompositionsController {
  readonly #store: CompositionStore;

  constructor(@Inject(COMPOSITION_STORE) store: CompositionStore) {
    this.#store = store;
  }

  /**
   * 200, not 201.
   *
   * Storing a composition that is already stored creates nothing - the id is the
   * content, so the second call is a lookup that happens to accept a body. Reporting
   * 201 would tell a client it had made a new resource when it had found an old one.
   */
  @Post()
  @HttpCode(200)
  store(
    @Body(new ZodValidationPipe(StoreCompositionBody)) body: StoreCompositionBody,
  ): Promise<Result<CompositionSummary>> {
    return this.#store.store(body.ir, body.label);
  }

  @Get()
  list(): Promise<Result<CompositionList>> {
    return this.#store.list();
  }

  /** The whole composition. Megabytes, and only the renderer and the player want it. */
  @Get(':id')
  async findOne(
    @Param('id', new ZodValidationPipe(CompositionIdParam)) id: string,
  ): Promise<Result<StoredComposition>> {
    const found = await this.#store.find(id);
    if (isErr(found)) return found;
    return found.value === null ? err(new NotFoundError('composition', id)) : ok(found.value);
  }
}
