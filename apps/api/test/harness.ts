/**
 * One booted application per e2e file, over in-memory SQLite and no network.
 *
 * Three properties every suite depends on, and each is enforced here rather than
 * remembered in each file:
 *
 * - **`:memory:` SQLite with the real migrations.** A mocked repository cannot fail a
 *   unique index, and the unique index is where non-negotiable #2 is actually enforced.
 * - **No provider keys.** `buildAdapters` registers nothing without them, so every
 *   provider port answers `UnsupportedCapabilityError` before touching a socket. CI
 *   opening a socket is not a slow test, it is a test that fails on someone else's
 *   outage.
 * - **`REDIS_URL` blank.** The whole suite therefore runs on the in-process queue,
 *   which makes "the app works with no Redis" a property the suite proves rather than
 *   claims.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { Ids } from '@rv/contracts';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import type { AppConfig } from '../src/config/app-config';
import { APP_CONFIG } from '../src/tokens';

export interface HarnessOptions {
  /** Merged over the defaults below. Use it to change one value, not to replace them. */
  readonly env?: Record<string, string>;
  /** Applied before the module is compiled - the only way to install a fake. */
  readonly override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export interface Harness {
  readonly app: INestApplication;
  readonly config: AppConfig;
  readonly ids: Ids;
  /**
   * The underlying http server, typed.
   *
   * `INestApplication.getHttpServer()` is declared as `any`, and handing that to
   * supertest lights up `no-unsafe-argument` at every call site in every suite. The
   * cast happens once, here, where the type is actually known.
   */
  readonly server: Server;
  close(): Promise<void>;
}

export async function bootHarness(options: HarnessOptions = {}): Promise<Harness> {
  const workspace = mkdtempSync(join(tmpdir(), 'rivayat-api-'));

  const env: Record<string, string> = {
    NODE_ENV: 'test',
    // `error`: a passing test should print nothing, and a failing one should print an
    // assertion rather than four hundred lines of request log.
    RV_LOG_LEVEL: 'error',
    RV_DB_URL: ':memory:',
    RV_WORKSPACE_DIR: workspace,
    RV_ASSET_STORE_DIR: join(workspace, 'assets'),
    RV_API_PREFIX: 'api',
    REDIS_URL: '',
    RV_QUEUE_CONCURRENCY: '2',
    RV_SEED: '42',
    // Explicitly blank: a developer's real `.env` must not reach the suite, and
    // `ignoreEnvFile` only covers the file - these keys could still arrive from the
    // shell if the object did not name them.
    OLLAMA_HOST: '',
    GEMINI_API_KEY: '',
    OPENROUTER_API_KEY: '',
    COMFYUI_HOST: '',
    RV_COMFYUI_ENABLED: 'false',
    ...options.env,
  };

  let builder = Test.createTestingModule({ imports: [AppModule.forRoot({ env })] });
  if (options.override !== undefined) builder = options.override(builder);

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });

  const config = app.get<AppConfig>(APP_CONFIG);
  configureApp(app, config);
  await app.init();

  return {
    app,
    config,
    ids: new Ids(),
    server: app.getHttpServer(),
    close: async () => {
      await app.close();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
