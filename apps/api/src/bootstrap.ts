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
 * Applies the global prefix, CORS and shutdown hooks.
 *
 * Exported so a `Test.createTestingModule(...).createNestApplication()` - which is the
 * only way to override a provider with a fake - gets exactly the same application as
 * `main.ts`.
 */
export function configureApp(app: INestApplication, config: AppConfig): void {
  app.setGlobalPrefix(config.http.globalPrefix);
  app.enableCors({ origin: config.http.corsOrigin, credentials: true });
  // Nest's own hooks: the event bus completes open SSE streams and the queue closes its
  // Redis connection. Without this a `ctrl-c` leaves both hanging until the socket
  // times out, and an e2e suite leaks a worker per test file.
  app.enableShutdownHooks();
}

export async function createApp(options: BootstrapOptions = {}): Promise<BootedApp> {
  const app = await NestFactory.create(
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
