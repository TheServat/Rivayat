import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { listDirectories, readJson, readJsonOrNull, writeBytes, writeJson } from './json-file';

const Doc = z.strictObject({ name: z.string().min(1), count: z.number().int() });

describe('json documents', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rv-json-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a validated document, creating parent directories', async () => {
    const path = join(dir, 'nested', 'deep', 'doc.json');
    const written = await writeJson(path, Doc, { name: 'دهکده', count: 1 });
    expect(written.ok).toBe(true);

    const read = await readJson(path, Doc, 'doc');
    expect(read.ok && read.value).toEqual({ name: 'دهکده', count: 1 });
  });

  it('writes UTF-8 without escaping non-ASCII, so the file is readable by a human', async () => {
    const path = join(dir, 'doc.json');
    await writeJson(path, Doc, { name: 'شخصیت‌ها', count: 0 });
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('شخصیت‌ها');
    expect(raw).not.toContain('\\u06');
  });

  it('reports a missing file as not-found, which is a different reaction from malformed', async () => {
    const read = await readJson(join(dir, 'absent.json'), Doc, 'doc');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.kind).toBe('not-found');
  });

  it('reports unparseable JSON as a validation failure naming the file', async () => {
    const path = join(dir, 'broken.json');
    await writeFile(path, '{ nope', 'utf8');
    const read = await readJson(path, Doc, 'doc');
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error.kind).toBe('validation');
      expect(read.error.message).toContain('not valid JSON');
    }
  });

  it('reports a schema mismatch with the issue paths, not just the wording', async () => {
    const path = join(dir, 'wrong.json');
    await writeFile(path, JSON.stringify({ name: '', count: 'x' }), 'utf8');
    const read = await readJson(path, Doc, 'doc');
    expect(read.ok).toBe(false);
    if (!read.ok) {
      const issues = read.error.context.issues as string[];
      expect(issues.some((issue) => issue.startsWith('name:'))).toBe(true);
      expect(issues.some((issue) => issue.startsWith('count:'))).toBe(true);
    }
  });

  /** A bug that writes a malformed document should be caught by the process that has the stack. */
  it('refuses to write a document that does not satisfy its own schema', async () => {
    const path = join(dir, 'never.json');
    const written = await writeJson(path, Doc, { name: '', count: 1.5 });
    expect(written.ok).toBe(false);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('readJsonOrNull distinguishes absent from broken', async () => {
    expect((await readJsonOrNull(join(dir, 'absent.json'), Doc, 'doc')).ok).toBe(true);
    const absent = await readJsonOrNull(join(dir, 'absent.json'), Doc, 'doc');
    expect(absent.ok && absent.value).toBeNull();

    const path = join(dir, 'broken.json');
    await writeFile(path, 'not json', 'utf8');
    expect((await readJsonOrNull(path, Doc, 'doc')).ok).toBe(false);
  });

  it('writes raw bytes for artefacts that are not documents', async () => {
    const path = join(dir, 'bytes', 'atlas.png');
    const written = await writeBytes(path, Uint8Array.from([1, 2, 3]));
    expect(written.ok).toBe(true);
    expect([...(await readFile(path))]).toEqual([1, 2, 3]);
  });

  it('lists directories, and treats a missing directory as empty rather than failing', async () => {
    expect(await listDirectories(join(dir, 'nowhere'))).toEqual([]);
    await writeJson(join(dir, 'a', 'doc.json'), Doc, { name: 'a', count: 0 });
    await writeJson(join(dir, 'b', 'doc.json'), Doc, { name: 'b', count: 0 });
    expect([...(await listDirectories(dir))].sort()).toEqual(['a', 'b']);
  });
});
