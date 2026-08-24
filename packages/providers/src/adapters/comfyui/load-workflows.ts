/**
 * Reading the workflow graphs off disk.
 *
 * Kept apart from the adapter so the adapter stays IO-free apart from HTTP: a test
 * hands it parsed objects, and wiring hands it these. It is also the only thing that
 * knows the workflows live in `tools/comfy-workflows/`, which means moving them is a
 * one-line change rather than a search.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type AppError, type Result, ValidationError, err, ok } from '@rv/shared-kernel';

import type { ComfyWorkflowSet } from './comfyui-adapter';

/** Filenames as they exist in `tools/comfy-workflows/`. */
export const COMFY_WORKFLOW_FILES = {
  txt2img: 'txt2img-lcm-draft.json',
  img2img: 'img2img-lcm-variant.json',
} as const;

/**
 * Graphs whose absence is a reduced capability rather than a broken install.
 *
 * `txt2img-lcm-parts-sheet.json` is here because an adapter without it still generates
 * images perfectly well - it just reports `servesPartsSheet: false` and the caller
 * routes around it. Failing the whole load for a missing optional graph would take the
 * free lane down entirely to protect one mode of it.
 */
export const COMFY_OPTIONAL_WORKFLOW_FILES = {
  partsSheet: 'txt2img-lcm-parts-sheet.json',
} as const;

export async function loadComfyWorkflows(
  directory: string,
): Promise<Result<ComfyWorkflowSet, AppError>> {
  const loaded: Record<string, unknown> = {};

  for (const [key, filename] of Object.entries(COMFY_WORKFLOW_FILES)) {
    const path = join(directory, filename);
    try {
      loaded[key] = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (caught) {
      return err(
        new ValidationError({
          message: `Could not read ComfyUI workflow ${filename}`,
          context: { path },
          cause: caught,
        }),
      );
    }
  }

  const optional: Record<string, unknown> = {};
  for (const [key, filename] of Object.entries(COMFY_OPTIONAL_WORKFLOW_FILES)) {
    try {
      optional[key] = JSON.parse(await readFile(join(directory, filename), 'utf8')) as unknown;
    } catch {
      // Left out of the set entirely, so `partsSheet !== undefined` is the whole test.
    }
  }

  return ok({
    txt2img: loaded.txt2img,
    img2img: loaded.img2img,
    ...(optional.partsSheet === undefined ? {} : { partsSheet: optional.partsSheet }),
  });
}
