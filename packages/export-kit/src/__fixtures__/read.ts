/**
 * Reading an export back in a test.
 *
 * Exports are bytes, deliberately - the port hands over files, not objects, so that
 * nothing in the package can quietly keep a live handle on "the exported document". That
 * means a test has to decode, and decoding once here keeps the assertions about the
 * format rather than about `TextDecoder`.
 */

import { expect } from 'vitest';

import type { ExportArtifact, ExportOutput } from '../port';

export function artifact(output: ExportOutput, path: string): ExportArtifact {
  const found = output.artifacts.find((candidate) => candidate.path === path);
  expect(
    found,
    `no artifact at "${path}" (have: ${output.artifacts.map((a) => a.path).join(', ')})`,
  ).toBeDefined();
  return found!;
}

export function readJson<T>(output: ExportOutput, path: string): T {
  return JSON.parse(new TextDecoder().decode(artifact(output, path).bytes)) as T;
}
