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

  return ok({ txt2img: loaded.txt2img, img2img: loaded.img2img });
}
