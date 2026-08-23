/**
 * The settings module.
 *
 * `SettingsService` is provided here rather than in the composition root because it
 * names no concrete class: it holds the `SettingsRepository` port, the machine layer
 * and a `Clock`, all of which arrive as tokens the root binds. A factory over tokens,
 * for the reason `app.module.ts` gives - esbuild emits no `design:paramtypes`, so a
 * class-typed constructor parameter would resolve to `Object` and fail at boot under
 * Vitest while working under `nest build`.
 */

import { Module } from '@nestjs/common';
import type { MachineLayerLoad, SettingsRepository } from '@rv/settings';
import type { Clock } from '@rv/shared-kernel';

import { CLOCK, MACHINE_SETTINGS, SETTINGS_REPOSITORY } from '../../tokens';
import { SETTINGS_SERVICE } from '../module-tokens';

import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  controllers: [SettingsController],
  providers: [
    {
      provide: SETTINGS_SERVICE,
      inject: [SETTINGS_REPOSITORY, MACHINE_SETTINGS, CLOCK],
      useFactory: (
        repository: SettingsRepository,
        machine: MachineLayerLoad,
        clock: Clock,
      ): SettingsService => new SettingsService(repository, machine, clock),
    },
  ],
  exports: [SETTINGS_SERVICE],
})
export class SettingsModule {}
