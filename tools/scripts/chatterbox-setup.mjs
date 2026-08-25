/**
 * Install Chatterbox into its own virtualenv and pull the English weights.
 *
 *     node tools/scripts/chatterbox-setup.mjs [--skip-install] [--skip-download] [--cpu]
 *
 * ## Why a private virtualenv, emphatically
 *
 * `chatterbox-tts` pins an exact torch version. Installing it into the system Python
 * downgraded a working 2.11.0+cu128 to 2.6.0 and took torchvision with it - so it lives
 * here, in `tools/chatterbox/.venv`, where a pin can only break the thing that asked for
 * it. ComfyUI keeps its own `.venv` for the same reason and was unaffected.
 *
 * ## The token
 *
 * `HF_TOKEN` is read from the root `.env` and handed to the child process through its
 * environment. It is never printed, never passed on a command line - a command line is
 * visible to every other process on the machine via the process table - and never
 * written to the log this script leaves behind. The script reports only whether a token
 * was found, because "is it set" is the question a person actually has.
 *
 * `HF_HOME` decides where several gigabytes land. Defaulting it under `workspace/` keeps
 * the download inside the project rather than in a home directory nobody remembers
 * filling, and `.env` already sets it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const VENV = join(ROOT, 'tools', 'chatterbox', '.venv');
const PY =
  process.platform === 'win32' ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python');

// ── the environment the child gets ──────────────────────────────────────────

const env = { ...process.env };
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !env[match[1]]) env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}
// Resolved against the repo root, not left as whatever `.env` wrote. `.env` has it as
// `./workspace/cache/huggingface`, and a relative HF_HOME means the child's working
// directory decides where several gigabytes land - so running this from `tools/` would
// quietly start a second copy of the cache.
env.HF_HOME = resolve(ROOT, env.HF_HOME ?? join('workspace', 'cache', 'huggingface'));
// Progress bars write \r-heavy output that is unreadable once captured to a file.
env.HF_HUB_DISABLE_PROGRESS_BARS = '1';

const hasToken = typeof env.HF_TOKEN === 'string' && env.HF_TOKEN.length > 0;
console.log(`venv      ${PY}`);
console.log(`HF_HOME   ${env.HF_HOME}`);
console.log(`HF_TOKEN  ${hasToken ? `set (${env.HF_TOKEN.length} chars)` : 'NOT SET'}`);
if (!hasToken) {
  // Not fatal: the English weights are a public repo and download without one. Said out
  // loud anyway, because the failure it causes on a gated repo is a 401 several minutes
  // into a multi-gigabyte download, which reads as a network problem.
  console.log('          public repos still download; a gated one would 401 after the wait');
}
if (!existsSync(PY)) {
  console.error(`\nno virtualenv at ${VENV}`);
  console.error('create it first:  python -m venv tools/chatterbox/.venv');
  process.exit(2);
}

function run(args, label) {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
  const result = spawnSync(PY, args, { env, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n${label} failed with exit code ${String(result.status)}`);
    process.exit(result.status ?? 1);
  }
}

/**
 * Pull the weights and prove they loaded.
 *
 * `from_pretrained` is what actually downloads, so calling it *is* the download - and it
 * is also the only check that the files on disk are the ones the library wants. A
 * script that downloaded and reported success without loading would pass on a truncated
 * cache.
 *
 * The device is CPU here on purpose: this step answers "are the weights present and
 * loadable", and doing it on CPU means it answers that same question on a machine whose
 * GPU is busy rendering.
 */
const WEIGHTS_PROBE = `
import torch
from chatterbox.tts import ChatterboxTTS

print(f"torch      {torch.__version__}")
print(f"cuda       {torch.cuda.is_available()}")

model = ChatterboxTTS.from_pretrained(device="cpu")
print(f"sample rate {model.sr}")
print("weights loaded")
`;

const skipInstall = process.argv.includes('--skip-install');
const skipDownload = process.argv.includes('--skip-download');

if (!skipInstall) {
  run(['-m', 'pip', 'install', '--upgrade', 'pip'], 'pip');
  // `chatterbox-tts` brings its own pinned torch. Letting it choose is the point of the
  // isolation - overriding the pin here would recreate the breakage in a smaller room.
  run(['-m', 'pip', 'install', 'chatterbox-tts'], 'chatterbox-tts');
  // `resemble-perth`, the watermarker Chatterbox constructs unconditionally, imports
  // `pkg_resources` - which setuptools removed in 81. Worse, perth catches the
  // ImportError and leaves `PerthImplicitWatermarker` as `None`, so the failure surfaces
  // three seconds into loading a 3 GB model as `'NoneType' object is not callable`,
  // naming neither setuptools nor pkg_resources. Pinning after the fact, because
  // chatterbox's own dependency resolution installs the newer one.
  run(['-m', 'pip', 'install', 'setuptools<81'], 'setuptools pin');
  // `chatterbox-tts` pins `torch==2.6.0` and pip resolves that to the CPU wheel, which
  // generates about five times slower than realtime - a 3.5 second line took 19 seconds.
  // `--force-reinstall` is required rather than tidy: pip compares `2.6.0` to `2.6.0+cpu`
  // and calls the requirement already satisfied, so a plain install is a no-op that looks
  // like a success. `--no-deps` keeps it from re-resolving everything else around it.
  if (!process.argv.includes('--cpu')) {
    run(
      [
        '-m',
        'pip',
        'install',
        '--force-reinstall',
        '--no-deps',
        'torch==2.6.0',
        'torchaudio==2.6.0',
        '--index-url',
        'https://download.pytorch.org/whl/cu124',
      ],
      'torch (cuda)',
    );
  }
}

if (!skipDownload) {
  run(['-c', WEIGHTS_PROBE], 'weights');
}

console.log('\nready.');
