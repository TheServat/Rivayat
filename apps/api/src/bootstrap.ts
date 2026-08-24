/**
 * Building the application, in one function both `main.ts` and the e2e suite call.
 *
 * The alternative - `main.ts` configures the app and the tests configure a second one -
 * is how a global prefix or a global pipe ends up bound in production and not under
 * test, which makes the suite pass on an application nobody ships. Everything that
 * changes request handling is in {@link configureApp}, and both paths call it.
 */

import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { MachineLayerLoad } from '@rv/settings';
import type { Logger } from '@rv/shared-kernel';

import { AppModule, type AppOptions } from './app.module';
import type { AppConfig } from './config/app-config';
import { APP_CONFIG, LOGGER, MACHINE_SETTINGS } from './tokens';

export interface BootstrapOptions extends AppOptions {
  /** Silences Nest's own startup banner. On in tests, off in a terminal. */
  readonly quiet?: boolean;
}

export interface BootedApp {
  readonly app: INestApplication;
  readonly config: AppConfig;
}

/**
 * How large a request body may be.
 *
 * Express defaults to 100 KB, which this API cannot live with: an `AnimationIR` *is* a
 * request body here. `POST /api/render` takes a whole composition and S10's run payload
 * carries one, by design and not by accident - ADR-0001 requires a render to be
 * reproducible from its input alone, so a body that named the IR by id would render
 * whatever that id points at now. A three-hundred-node test fixture is already 106 KB
 * and a real episode is far more.
 *
 * The failure it produced was doubly bad: the body was refused, and the refusal arrived
 * as a **500**, because body-parser's error is a plain `Error` carrying a `status`
 * rather than a Nest `HttpException`. `app-error.filter.ts` now maps it properly, so
 * this limit is the ceiling rather than the only thing standing between a large
 * composition and an unexplained internal error.
 *
 * 64 MB: generous enough for a feature-length IR, small enough that it is still a limit.
 */
const MAX_BODY_BYTES = '64mb';

/**
 * Applies the body limit, the global prefix, CORS and shutdown hooks.
 *
 * Exported so a `Test.createTestingModule(...).createNestApplication()` - which is the
 * only way to override a provider with a fake - gets exactly the same application as
 * `main.ts`.
 */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  // Nest's own re-registration, rather than `app.use(express.json(...))`: express is a
  // transitive dependency of `@nestjs/platform-express`, and importing it directly here
  // would be this app depending on a package it does not declare.
  app.useBodyParser('json', { limit: MAX_BODY_BYTES });
  app.useBodyParser('urlencoded', { limit: MAX_BODY_BYTES, extended: true });
  app.setGlobalPrefix(config.http.globalPrefix);
  app.enableCors({ origin: config.http.corsOrigin, credentials: true });
  // Nest's own hooks: the event bus completes open SSE streams and the queue closes its
  // Redis connection. Without this a `ctrl-c` leaves both hanging until the socket
  // times out, and an e2e suite leaks a worker per test file.
  app.enableShutdownHooks();
}

export async function createApp(options: BootstrapOptions = {}): Promise<BootedApp> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(options.env === undefined ? {} : { env: options.env }),
    { logger: options.quiet === true ? false : ['error', 'warn', 'log'] },
  );

  const config = app.get<AppConfig>(APP_CONFIG);
  configureApp(app, config);

  await app.init();
  reportMachineLayer(app);
  return { app, config };
}

/**
 * Says out loud what `.env` did and did not do.
 *
 * A typo'd environment variable that silently does nothing is the exact failure the
 * settings registry exists to prevent - the operator sets `RV_BUDGET_PER_RUN_USD`
 * instead of `RV_BUDGET_USD_PER_RUN`, nothing complains, and the budget guard runs on
 * the default. `loadMachineLayer` already detects it; this is what makes the detection
 * reach a human. It is a `warn`, not a throw: a single bad variable must not stop the
 * process, or the operator has no working settings screen in which to fix it.
 *
 * The same warnings travel in `GET /api/settings`, so the screen shows them too. A
 * warning that only ever reaches a terminal nobody is watching prevents nothing.
 */
function reportMachineLayer(app: INestApplication): void {
  const machine = app.get<MachineLayerLoad>(MACHINE_SETTINGS);
  const log = app.get<Logger>(LOGGER).child({ component: 'settings' });

  log.info('machine layer read', {
    keys: Object.keys(machine.layer.values).length,
    warnings: machine.warnings.length,
  });
  for (const warning of machine.warnings) {
    log.warn('environment variable ignored', {
      variable: warning.variable,
      reason: warning.reason,
      detail: warning.message,
    });
  }
}
