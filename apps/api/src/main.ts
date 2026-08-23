/**
 * The process entry point.
 *
 * Two responsibilities beyond starting the server, and both are about failing well.
 *
 * `reflect-metadata` is imported first, before anything that could pull in a decorated
 * class. Nest reads its DI metadata off the `Reflect` polyfill, and importing it second
 * produces a `Reflect.getMetadata is not a function` at wiring time - reported against
 * whichever class happened to load first, which has nothing to do with the cause.
 *
 * The configuration is checked **before** Nest is constructed. `RivayatConfigModule`
 * validates it too, and that is the authoritative path - but a failure there surfaces
 * through Nest's `ExceptionHandler`, which prints a framework stack above the two lines
 * that name the bad keys. An operator staring at a boot failure should see the keys
 * first, so the same schema runs once here, cheaply, to short-circuit that.
 */

import 'reflect-metadata';

import { isAppError, isErr } from '@rv/shared-kernel';

import { createApp } from './bootstrap';
import { loadConfig } from './config/app-config';

/** Prints the message and nothing else. A config error's stack is always this file. */
function reportAndExit(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const preflight = loadConfig(process.env);
  if (isErr(preflight)) {
    reportAndExit(preflight.error.message);
    return;
  }

  const { app, config } = await createApp();
  await app.listen(config.http.port);
}

main().catch((caught: unknown) => {
  if (isAppError(caught) && caught.kind === 'validation') {
    reportAndExit(caught.message);
    return;
  }
  // Anything else is worth its stack: it is a wiring failure, not a typo in `.env`.
  console.error(caught);
  process.exitCode = 1;
});
