/**
 * `.env` in, a validated {@link AppConfig} out, or the process refuses to start.
 *
 * `@nestjs/config` is used for what it is good at - finding and merging dotenv files -
 * and its `validate` hook is where the Zod schema runs. That placement matters: the
 * hook runs during module initialisation, so a bad value fails `NestFactory.create`
 * with the offending keys named, rather than surfacing as a 500 on whichever request
 * first touches the setting.
 */

import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { type EnvSource, type MachineLayerLoad, loadMachineLayer } from '@rv/settings';

import { APP_CONFIG, MACHINE_SETTINGS } from '../tokens';
import { type AppConfig, loadConfig } from './app-config';

/** Where the parsed config is filed inside `ConfigService`. */
const CONFIG_KEY = 'rivayat';

/**
 * The environment, reduced to the string-valued entries a shell could have produced.
 *
 * `loadMachineLayer` coerces per the registry's declared `format`, so it wants the text
 * that was in `.env` and not a number someone already parsed. A test that passes
 * `{ RV_API_PORT: 3000 }` is passing something `process.env` could never hold, and
 * dropping it here is more honest than stringifying it into a value the operator never
 * wrote.
 */
function stringEntries(raw: Record<string, unknown>): EnvSource {
  const source: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') source[name] = value;
  }
  return source;
}

export interface RivayatConfigOptions {
  /**
   * Environment to read instead of `process.env` and the dotenv files.
   *
   * Present so an e2e suite can boot the whole app against `:memory:` and an empty
   * `REDIS_URL` without mutating the process it runs in - which would leak into every
   * other test file in the same worker.
   */
  readonly env?: Record<string, unknown>;
}

@Module({})
export class RivayatConfigModule {
  static forRoot(options: RivayatConfigOptions = {}): DynamicModule {
    const explicit = options.env;

    // Captured from `validate` rather than re-read from `process.env`, because the two
    // differ exactly when it matters: an e2e suite supplies its own environment, and a
    // machine layer read from the real process would resolve that suite's settings from
    // the developer's `.env`. `validate` runs during `ConfigModule`'s initialisation,
    // which is before any provider below is constructed.
    let machine: MachineLayerLoad = loadMachineLayer({});

    return {
      module: RivayatConfigModule,
      global: true,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          // An explicit env is the whole environment, not an overlay: a test that asks
          // for `:memory:` must not inherit the developer's `RV_DB_URL` from a file
          // sitting two directories up.
          ignoreEnvFile: explicit !== undefined,
          // The repository root as well as the process directory. There is one `.env`
          // in this repo and it sits at the root, next to `.env.example`; `pnpm --filter
          // @rv/api dev` runs from `apps/api`, where dotenv looked and found nothing -
          // so every credential in that file was being ignored and every setting
          // resolved to its built-in default. Earlier entries win, so a per-app override
          // still beats the shared one.
          envFilePath: ['.env.local', '.env', '../../.env.local', '../../.env'],
          validate: (raw: Record<string, unknown>): Record<string, unknown> => {
            const source = explicit ?? raw;
            machine = loadMachineLayer(stringEntries(source));
            const parsed = loadConfig(source);
            if (!parsed.ok) throw parsed.error;
            return { [CONFIG_KEY]: parsed.value };
          },
        }),
      ],
      providers: [
        {
          provide: APP_CONFIG,
          inject: [ConfigService],
          useFactory: (config: ConfigService): AppConfig =>
            config.getOrThrow<AppConfig>(CONFIG_KEY),
        },
        {
          // Depends on `APP_CONFIG` only for the ordering: it guarantees `validate` has
          // run, so `machine` holds the load rather than the empty placeholder.
          provide: MACHINE_SETTINGS,
          inject: [APP_CONFIG],
          useFactory: (_config: AppConfig): MachineLayerLoad => machine,
        },
      ],
      exports: [APP_CONFIG, MACHINE_SETTINGS],
    };
  }
}
