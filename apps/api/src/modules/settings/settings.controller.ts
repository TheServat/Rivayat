/**
 * The settings endpoints. Two of them, both thin.
 *
 * Everything interesting is in `SettingsService`; what lives here is the HTTP shape -
 * which query parameters name a scope, which path segment names a layer, and which
 * schema each is validated with. That split is deliberate: the registry, the resolver
 * and the validator are all reusable from the CLI and from a pipeline stage, and none
 * of them should have to know what a request is.
 */

import { Body, Controller, Get, Inject, Param, Put, Query } from '@nestjs/common';
import { type ProjectId, type RunId } from '@rv/contracts';
import type { Result } from '@rv/shared-kernel';

import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SETTINGS_SERVICE } from '../module-tokens';

import {
  ProjectIdQuery,
  RunIdQuery,
  SettingsPatch,
  WritableSettingsScope,
  type SettingsSnapshot,
} from './settings.contracts';
import type { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  readonly #settings: SettingsService;

  constructor(@Inject(SETTINGS_SERVICE) settings: SettingsService) {
    this.#settings = settings;
  }

  /**
   * The whole registry, resolved for a scope.
   *
   * One request, not one per group: the settings screen needs every descriptor to
   * decide what is visible (`dependsOn` reads other settings' resolved values), so
   * paginating it would mean a form that cannot know whether to draw its own fields.
   */
  @Get()
  view(
    @Query('projectId', new ZodValidationPipe(ProjectIdQuery)) projectId: ProjectId | undefined,
    @Query('runId', new ZodValidationPipe(RunIdQuery)) runId: RunId | undefined,
  ): Promise<Result<SettingsSnapshot>> {
    return this.#settings.snapshot({
      projectId: projectId ?? null,
      runId: runId ?? null,
    });
  }

  /**
   * Writes one layer, and answers with the whole snapshot again.
   *
   * `:scope` is the layer, and `machine` is not one of its values: the machine layer is
   * `.env`, the repository refuses to store it, and a route that accepted the word and
   * could not honour it would be worse than one that never offered it. A machine-scope
   * setting is therefore read-only through the API and the snapshot says so by carrying
   * the descriptor's `env` binding, so the UI can name the variable to edit instead.
   */
  @Put(':scope')
  write(
    @Param('scope', new ZodValidationPipe(WritableSettingsScope)) scope: WritableSettingsScope,
    @Body(new ZodValidationPipe(SettingsPatch)) patch: SettingsPatch,
  ): Promise<Result<SettingsSnapshot>> {
    return this.#settings.write(scope, patch);
  }
}
