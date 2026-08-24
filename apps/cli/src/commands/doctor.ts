/**
 * `rv doctor` - what is actually available on this machine.
 *
 * Every other command depends on some subset of this, and the failure mode without it
 * is a stack trace from deep inside an adapter. Checking first, and saying plainly
 * which lane is open, is cheaper than diagnosing that.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** What stops working without it. */
  readonly enables: string;
}

const TIMEOUT_MS = 6000;

async function probeHttp(url: string): Promise<{ ok: boolean; body: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { ok: response.ok, body: (await response.text()).slice(0, 400) };
  } catch (caught: unknown) {
    return { ok: false, body: caught instanceof Error ? caught.message : String(caught) };
  }
}

async function probeBinary(command: string, args: readonly string[]): Promise<Check['detail']> {
  try {
    const { stdout, stderr } = await run(command, [...args], { timeout: TIMEOUT_MS });
    return (stdout || stderr).split('\n')[0]?.trim() ?? '(no output)';
  } catch (caught: unknown) {
    return `not found (${caught instanceof Error ? caught.message.split('\n')[0] : 'unknown'})`;
  }
}

export async function doctor(env: NodeJS.ProcessEnv): Promise<readonly Check[]> {
  const checks: Check[] = [];

  const ollamaHost = env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const ollama = await probeHttp(`${ollamaHost}/api/tags`);
  const models = ollama.ok
    ? [...ollama.body.matchAll(/"name":"([^"]+)"/g)].map((m) => m[1]).join(', ')
    : ollama.body;
  checks.push({
    name: 'Ollama',
    ok: ollama.ok,
    detail: ollama.ok ? models : models,
    enables: 'the free local text lane - story, cast, extraction',
  });

  const comfyHost = env.COMFYUI_HOST ?? 'http://127.0.0.1:8288';
  const comfy = await probeHttp(`${comfyHost}/system_stats`);
  checks.push({
    name: 'ComfyUI',
    ok: comfy.ok,
    detail: comfy.ok
      ? (/"comfyui_version":\s*"([^"]+)"/.exec(comfy.body)?.[1] ?? 'reachable')
      : `${comfyHost} - ${comfy.body}`,
    enables: 'the free local image lane (optional; the cloud lane works without it)',
  });

  checks.push({
    name: 'FFmpeg',
    ok: true,
    detail: await probeBinary(env.RV_FFMPEG_PATH ?? 'ffmpeg', ['-version']),
    enables: 'encoding rendered frames into deliverable video',
  });

  checks.push({
    name: 'Gemini key',
    ok: (env.GEMINI_API_KEY ?? '') !== '',
    detail: (env.GEMINI_API_KEY ?? '') !== '' ? 'set' : 'absent',
    enables: 'the paid image lane and the free Gemini text tier',
  });

  checks.push({
    name: 'OpenRouter key',
    ok: (env.OPENROUTER_API_KEY ?? '') !== '',
    detail: (env.OPENROUTER_API_KEY ?? '') !== '' ? 'set' : 'absent',
    enables: 'model failover and the 18 free text/vision models',
  });

  return checks;
}

export function renderChecks(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks
    .map((c) => {
      const mark = c.ok ? '  OK ' : ' MISS';
      return `${mark}  ${c.name.padEnd(width)}  ${c.detail}\n        ${' '.repeat(width)}  -> ${c.enables}`;
    })
    .join('\n');
}
