/**
 * `GET /api/openapi.json`.
 *
 * Built once at first request and cached: the document is a pure function of the
 * schemas and the route table, both of which are frozen at import time, so rebuilding
 * it per request would be several hundred `toJSONSchema` calls to produce the same
 * bytes. Cached rather than built at module load so that a schema error surfaces as a
 * failing request with a stack in the log rather than as a process that will not boot.
 */

import { Controller, Get, Inject } from '@nestjs/common';

import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../tokens';
import { buildOpenApiDocument } from './build-document';

const INFO = {
  title: 'Rivayat API',
  version: '0.1.0',
  description:
    'Idea to animated multi-format series. Every schema in this document is emitted ' +
    'from the Zod schema the API validates with (@rv/contracts); none is hand-written.',
} as const;

@Controller('openapi.json')
export class OpenApiController {
  readonly #config: AppConfig;
  #cached: Record<string, unknown> | null = null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.#config = config;
  }

  @Get()
  document(): Record<string, unknown> {
    this.#cached ??= buildOpenApiDocument({
      info: INFO,
      basePath: this.#config.http.globalPrefix,
    });
    return this.#cached;
  }
}
