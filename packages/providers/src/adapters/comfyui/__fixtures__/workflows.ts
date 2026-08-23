/**
 * The real workflow graphs, read from `tools/comfy-workflows/`.
 *
 * Tests read the actual files rather than a copy. A copy would drift the moment
 * someone edits a graph, and the substitution contract would then be verified against
 * a template that no longer exists.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Resolved from this file, so it survives the package being moved. */
export const WORKFLOW_DIR = fileURLToPath(
  new URL('../../../../../../tools/comfy-workflows/', import.meta.url),
);

export function readWorkflow(filename: string): unknown {
  return JSON.parse(readFileSync(`${WORKFLOW_DIR}${filename}`, 'utf8')) as unknown;
}
