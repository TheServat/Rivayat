#!/usr/bin/env node
// Smoke test for the free local ComfyUI draft lane.
//
// Zero repo dependencies on purpose: this script must run before (and independently of)
// `pnpm install`, so it uses only Node builtins. It is also the reference implementation
// of the placeholder-substitution contract that the real ComfyUI adapter must follow.
//
//   node tools/scripts/comfy-smoke.mjs --help
//
// Exits non-zero on any failure. Every assertion is numeric, not "a file appeared".

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------
// Placeholder contract
// ---------------------------------------------------------------------------

// Placeholders whose substituted text must reach ComfyUI as a JSON number, not a
// string. ComfyUI validates INT/FLOAT node inputs by type, so `"steps": "4"` is
// rejected where `"steps": 4` is accepted. Everything not listed here stays a string.
const NUMERIC_PLACEHOLDERS = new Set([
  'seed',
  'steps',
  'cfg',
  'width',
  'height',
  'lora_strength',
  'batch_size',
  'denoise',
  'grid_cols',
  'grid_rows',
]);

const DEFAULTS = {
  prompt:
    'a weathered brass pocket watch resting on dark linen, ornate engraved case, ' +
    'warm rim light, painterly illustration, high detail',
  negative:
    'blurry, low quality, jpeg artifacts, watermark, signature, text, deformed, ' +
    'extra limbs, oversaturated',
  seed: 424242,
  steps: 6,
  cfg: 1.5,
  width: 512,
  height: 512,
  checkpoint: 'dreamshaper_8.safetensors',
  lora: 'lcm-lora-sdv1-5.safetensors',
  lora_strength: 1.0,
  sampler: 'lcm',
  scheduler: 'sgm_uniform',
  batch_size: 1,
  denoise: 0.4,
  filename_prefix: 'rivayat-smoke',
  // parts-sheet only
  style: 'flat vector illustration, clean line art, muted earth palette',
  parts: 'head, torso, left arm, right arm, left leg, right leg',
  background: 'flat neutral light grey',
  grid_cols: 3,
  grid_rows: 2,
  // img2img only
  image: '',
  variant: 'autumn colourway, warm rust and ochre palette',
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    let key;
    let val;
    if (eq !== -1) {
      key = tok.slice(2, eq);
      val = tok.slice(eq + 1);
    } else {
      key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        val = 'true';
      } else {
        val = next;
        i += 1;
      }
    }
    out[key.replace(/-/g, '_')] = val;
  }
  return out;
}

const HELP = `
comfy-smoke.mjs — prove the local ComfyUI draft lane works end to end.

  node tools/scripts/comfy-smoke.mjs [options]

Connection
  --host <url>            ComfyUI base URL          (default http://127.0.0.1:8288)
  --timeout <sec>         per-job wall clock        (default 300)

Workflow
  --workflow <path>       API-format workflow JSON  (default tools/comfy-workflows/txt2img-lcm-draft.json)
  --out <dir>             output directory          (default workspace/cache/smoke)
  --name <basename>       output basename           (default derived from workflow + params)

Placeholders (each maps to {{name}} in the workflow)
  --prompt --negative --seed --steps --cfg --width --height --checkpoint
  --lora --lora-strength --sampler --scheduler --batch-size --denoise
  --filename-prefix --style --parts --grid-cols --grid-rows --image

Assertions
  --min-stddev <n>        reject flat/blank output  (default 3.0)
  --expect-width <n>      default: --width
  --expect-height <n>     default: --height

Modes
  --repeat <n>            run n times with the same seed and assert identical sha256
  --json                  emit a machine-readable summary on stdout
  --keep-all              with --repeat, keep every run's file (default: keep run 1)
  --help
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const HOST = String(args.host ?? 'http://127.0.0.1:8288').replace(/\/+$/, '');
const TIMEOUT_MS = Number(args.timeout ?? 300) * 1000;
const WORKFLOW_PATH = resolve(
  REPO,
  args.workflow ?? 'tools/comfy-workflows/txt2img-lcm-draft.json',
);
const OUT_DIR = resolve(REPO, args.out ?? 'workspace/cache/smoke');
const REPEAT = Math.max(1, Number(args.repeat ?? 1));
const AS_JSON = args.json === 'true' || args.json === true;

// Resolved placeholder values: CLI overrides win, defaults fill the rest.
const values = { ...DEFAULTS };
for (const [key, def] of Object.entries(DEFAULTS)) {
  if (args[key] === undefined) continue;
  values[key] = typeof def === 'number' ? Number(args[key]) : String(args[key]);
}
for (const key of NUMERIC_PLACEHOLDERS) {
  if (typeof values[key] === 'number' && !Number.isFinite(values[key])) {
    fail(`--${key} is not a finite number`);
  }
}

const EXPECT_W = Number(args.expect_width ?? values.width);
const EXPECT_H = Number(args.expect_height ?? values.height);
const MIN_STDDEV = Number(args.min_stddev ?? 3.0);

const log = (...m) => {
  if (!AS_JSON) console.log(...m);
};
function fail(msg) {
  console.error(`\n  FAIL  ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Substitution
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Walk the workflow graph and replace every {{name}} occurrence.
 *
 * Two rules, and the adapter must implement both:
 *  1. A value that is *exactly* one placeholder for a NUMERIC_PLACEHOLDERS name
 *     becomes a JSON number. ComfyUI type-checks INT/FLOAT inputs.
 *  2. Any other occurrence is interpolated as text, so prompt scaffolds can embed
 *     placeholders mid-sentence.
 */
function substitute(node, vals, seen) {
  if (typeof node === 'string') {
    const whole = node.match(/^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/);
    if (whole) {
      const name = whole[1];
      seen.add(name);
      if (!(name in vals)) return node; // left for the leftover check to catch
      return NUMERIC_PLACEHOLDERS.has(name) ? Number(vals[name]) : String(vals[name]);
    }
    return node.replace(PLACEHOLDER, (match, name) => {
      seen.add(name);
      return name in vals ? String(vals[name]) : match;
    });
  }
  if (Array.isArray(node)) return node.map((n) => substitute(n, vals, seen));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = substitute(v, vals, seen);
    return out;
  }
  return node;
}

function buildPrompt(workflowJson, vals) {
  const seen = new Set();
  const filled = substitute(workflowJson, vals, seen);
  const leftover = JSON.stringify(filled).match(PLACEHOLDER);
  if (leftover) {
    fail(
      `workflow still contains unsubstituted placeholders: ${[...new Set(leftover)].join(', ')}`,
    );
  }
  // `_meta` is accepted but ignored by ComfyUI; strip it so the POST body is minimal.
  const clean = {};
  for (const [id, node] of Object.entries(filled)) {
    const { _meta, ...rest } = node;
    clean[id] = rest;
  }
  return { prompt: clean, placeholders: [...seen].sort() };
}

// ---------------------------------------------------------------------------
// Minimal PNG reader (no npm dependency)
// ---------------------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('not a PNG (bad signature)');
  }
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len; // len + type(4) + data + crc(4)
  }
  if (!ihdr) throw new Error('PNG has no IHDR chunk');
  if (idat.length === 0) throw new Error('PNG has no IDAT data');
  if (ihdr.interlace !== 0) throw new Error('interlaced PNG not supported by this reader');
  if (ihdr.bitDepth !== 8 && ihdr.bitDepth !== 16) {
    throw new Error(`unsupported bit depth ${ihdr.bitDepth}`);
  }
  const channelsFor = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsFor[ihdr.colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${ihdr.colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = (channels * ihdr.bitDepth) / 8;
  const stride = Math.ceil((ihdr.width * channels * ihdr.bitDepth) / 8);
  const expected = (stride + 1) * ihdr.height;
  if (raw.length < expected) {
    throw new Error(`inflated PNG data too short: ${raw.length} < ${expected}`);
  }

  // Undo the per-scanline PNG filters (RFC 2083 §6).
  const out = Buffer.alloc(stride * ihdr.height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      const v = line[x];
      let recon;
      switch (filter) {
        case 0:
          recon = v;
          break;
        case 1:
          recon = v + a;
          break;
        case 2:
          recon = v + b;
          break;
        case 3:
          recon = v + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          recon = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unknown PNG filter type ${filter} on row ${y}`);
      }
      cur[x] = recon & 0xff;
    }
    prev = cur;
  }
  return { ...ihdr, channels, stride, pixels: out };
}

/** Per-channel mean/stddev over the colour channels (alpha excluded). */
function imageStats(png) {
  const { width, height, channels, bitDepth, stride, pixels } = png;
  const colorChannels = channels === 2 ? 1 : channels === 4 ? 3 : channels;
  const step = bitDepth === 16 ? 2 : 1;
  const sums = new Float64Array(colorChannels);
  const sqs = new Float64Array(colorChannels);
  const uniq = new Set();
  const n = width * height;
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const base = row + x * channels * step;
      let key = 0;
      for (let c = 0; c < colorChannels; c += 1) {
        const v = pixels[base + c * step]; // high byte for 16-bit: close enough
        sums[c] += v;
        sqs[c] += v * v;
        key = key * 256 + v;
      }
      if (uniq.size < 4096) uniq.add(key);
    }
  }
  const stddev = [];
  const mean = [];
  for (let c = 0; c < colorChannels; c += 1) {
    const m = sums[c] / n;
    mean.push(m);
    stddev.push(Math.sqrt(Math.max(0, sqs[c] / n - m * m)));
  }
  return {
    mean: mean.map((v) => Number(v.toFixed(2))),
    stddev: stddev.map((v) => Number(v.toFixed(2))),
    maxStddev: Number(Math.max(...stddev).toFixed(2)),
    distinctColors: uniq.size, // saturates at 4096
  };
}

// ---------------------------------------------------------------------------
// ComfyUI client
// ---------------------------------------------------------------------------

async function getJson(path, ms = 15000) {
  const res = await fetch(`${HOST}${path}`, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${res.statusText}`);
  return res.json();
}

async function preflight() {
  let stats;
  try {
    stats = await getJson('/system_stats', 5000);
  } catch (err) {
    fail(
      `ComfyUI is not reachable at ${HOST} (${err.message}).\n` +
        `        Start it with:  powershell -ExecutionPolicy Bypass -File tools\\scripts\\comfy-start.ps1\n` +
        `                   or:  bash tools/scripts/comfy-start.sh`,
    );
  }
  const objectInfo = await getJson('/object_info', 60000);
  for (const cls of ['CheckpointLoaderSimple', 'LoraLoader', 'KSampler']) {
    if (!objectInfo[cls]) fail(`ComfyUI /object_info is missing node type ${cls}`);
  }
  const ckpts = objectInfo.CheckpointLoaderSimple.input.required.ckpt_name[0];
  const loras = objectInfo.LoraLoader.input.required.lora_name[0];
  if (!ckpts.includes(values.checkpoint)) {
    fail(`checkpoint "${values.checkpoint}" not found. Available: ${ckpts.join(', ') || '(none)'}`);
  }
  if (values.lora && !loras.includes(values.lora)) {
    fail(`lora "${values.lora}" not found. Available: ${loras.join(', ') || '(none)'}`);
  }
  return { stats, nodeTypes: Object.keys(objectInfo).length };
}

async function queuePrompt(prompt, clientId) {
  const res = await fetch(`${HOST}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: clientId }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) fail(`POST /prompt -> ${res.status}\n${text}`);
  const body = JSON.parse(text);
  if (body.node_errors && Object.keys(body.node_errors).length > 0) {
    fail(`ComfyUI rejected the graph:\n${JSON.stringify(body.node_errors, null, 2)}`);
  }
  if (!body.prompt_id) fail(`POST /prompt returned no prompt_id:\n${text}`);
  return body.prompt_id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHistory(promptId) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const hist = await getJson(`/history/${promptId}`);
    const entry = hist[promptId];
    if (entry) {
      const status = entry.status ?? {};
      if (status.status_str === 'error' || status.completed === false) {
        const msgs = JSON.stringify(status.messages ?? [], null, 2);
        fail(`prompt ${promptId} failed:\n${msgs}`);
      }
      if (status.completed === true || entry.outputs) return entry;
    }
    await sleep(250);
  }
  fail(`timed out after ${TIMEOUT_MS / 1000}s waiting for prompt ${promptId}`);
}

/**
 * ComfyUI caches node outputs keyed by their resolved inputs, so re-queueing an
 * identical graph returns the previous image in ~10ms without running the sampler.
 * That would turn a determinism check into a tautology and a benchmark into a lie.
 * Queueing this seed-shifted decoy between measured runs evicts the sampler's cache
 * entry, forcing the next real run to execute end to end.
 */
function seedDecoy(prompt) {
  const decoy = JSON.parse(JSON.stringify(prompt));
  let bumped = 0;
  for (const node of Object.values(decoy)) {
    for (const key of ['seed', 'noise_seed']) {
      if (typeof node.inputs?.[key] === 'number') {
        node.inputs[key] += 1;
        bumped += 1;
      }
    }
  }
  return bumped > 0 ? decoy : null;
}

function collectImages(entry) {
  const imgs = [];
  for (const out of Object.values(entry.outputs ?? {})) {
    for (const img of out.images ?? []) imgs.push(img);
  }
  return imgs;
}

async function download(img) {
  const qs = new URLSearchParams({
    filename: img.filename,
    subfolder: img.subfolder ?? '',
    type: img.type ?? 'output',
  });
  const res = await fetch(`${HOST}/view?${qs}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) fail(`GET /view (${img.filename}) -> ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const info = await preflight();
  const dev = info.stats.devices?.[0] ?? {};
  log(
    `ComfyUI ${info.stats.system.comfyui_version} @ ${HOST} — ` +
      `${info.nodeTypes} node types, ${dev.name ?? 'no device'}, ` +
      `${(Number(dev.vram_total ?? 0) / 1024 ** 3).toFixed(2)} GiB VRAM`,
  );

  let workflowJson;
  try {
    workflowJson = JSON.parse(readFileSync(WORKFLOW_PATH, 'utf8'));
  } catch (err) {
    fail(`cannot read workflow ${WORKFLOW_PATH}: ${err.message}`);
  }
  const { prompt, placeholders } = buildPrompt(workflowJson, values);
  log(`workflow ${WORKFLOW_PATH.replace(REPO, '.')} — placeholders: ${placeholders.join(', ')}`);
  log(
    `params  ${values.width}x${values.height} steps=${values.steps} cfg=${values.cfg} ` +
      `seed=${values.seed} sampler=${values.sampler}/${values.scheduler} ` +
      `lora=${values.lora_strength}`,
  );

  mkdirSync(OUT_DIR, { recursive: true });
  const baseName =
    args.name ??
    `${WORKFLOW_PATH.split(/[\\/]/)
      .pop()
      .replace(
        /\.json$/,
        '',
      )}-${values.width}x${values.height}-s${values.steps}-seed${values.seed}`;

  const clientId = `rivayat-smoke-${process.pid}`;
  const runs = [];

  for (let r = 0; r < REPEAT; r += 1) {
    if (r > 0) {
      const decoy = seedDecoy(prompt);
      if (decoy) await waitForHistory(await queuePrompt(decoy, clientId));
      else log('  (warning: no seed input found — cache eviction skipped)');
    }
    const tStart = Date.now();
    const promptId = await queuePrompt(prompt, clientId);
    const entry = await waitForHistory(promptId);
    const elapsed = (Date.now() - tStart) / 1000;

    const images = collectImages(entry);
    if (images.length === 0) fail(`prompt ${promptId} completed but produced no images`);

    const bytes = await download(images[0]);
    const sha = createHash('sha256').update(bytes).digest('hex');

    let png;
    try {
      png = readPng(bytes);
    } catch (err) {
      fail(`output is not a readable PNG: ${err.message}`);
    }
    const stats = imageStats(png);

    const keep = REPEAT === 1 || r === 0 || args.keep_all === 'true';
    const outPath = join(OUT_DIR, REPEAT === 1 ? `${baseName}.png` : `${baseName}-run${r + 1}.png`);
    if (keep) writeFileSync(outPath, bytes);

    // ---- assertions -------------------------------------------------------
    if (bytes.length < 1024) fail(`output is suspiciously small (${bytes.length} bytes)`);
    if (png.width !== EXPECT_W || png.height !== EXPECT_H) {
      fail(`expected ${EXPECT_W}x${EXPECT_H}, got ${png.width}x${png.height}`);
    }
    if (!Number.isFinite(stats.maxStddev))
      fail('pixel statistics are NaN — decode produced garbage');
    if (stats.maxStddev < MIN_STDDEV) {
      fail(
        `output looks blank/uniform: max channel stddev ${stats.maxStddev} < ${MIN_STDDEV} ` +
          `(mean ${stats.mean.join('/')}, ${stats.distinctColors} distinct colours)`,
      );
    }
    if (stats.distinctColors < 64) {
      fail(`output has only ${stats.distinctColors} distinct colours — likely a solid fill`);
    }
    // A repeat run that returns far faster than the first was served from ComfyUI's
    // node cache, which means the sampler never ran and determinism was not tested.
    if (r > 0 && elapsed < runs[0].seconds * 0.25) {
      fail(
        `run ${r + 1} finished in ${elapsed.toFixed(2)}s vs ${runs[0].seconds}s for run 1 — ` +
          'this is a ComfyUI cache hit, so determinism was not actually exercised',
      );
    }
    // -----------------------------------------------------------------------

    const sec = Number(elapsed.toFixed(2));
    runs.push({
      run: r + 1,
      promptId,
      seconds: sec,
      file: keep ? outPath : null,
      bytes: bytes.length,
      width: png.width,
      height: png.height,
      colorType: png.colorType,
      bitDepth: png.bitDepth,
      sha256: sha,
      ...stats,
    });
    log(
      `  run ${r + 1}/${REPEAT}  ${sec}s  ${png.width}x${png.height}  ` +
        `${(bytes.length / 1024).toFixed(0)} KiB  stddev ${stats.maxStddev}  ` +
        `colours ${stats.distinctColors}${stats.distinctColors >= 4096 ? '+' : ''}  ` +
        `sha ${sha.slice(0, 12)}`,
    );
  }

  const secs = runs.map((r) => r.seconds);
  const deterministic = new Set(runs.map((r) => r.sha256)).size === 1;
  const summary = {
    ok: true,
    host: HOST,
    workflow: WORKFLOW_PATH,
    params: values,
    runs,
    firstRunSeconds: secs[0],
    warmSeconds:
      secs.length > 1
        ? Number((secs.slice(1).reduce((a, b) => a + b, 0) / (secs.length - 1)).toFixed(2))
        : null,
    deterministic: REPEAT > 1 ? deterministic : null,
    totalSeconds: Number(((Date.now() - t0) / 1000).toFixed(2)),
  };

  if (REPEAT > 1 && !deterministic) {
    console.error('\n  FAIL  determinism broken: identical seed produced differing sha256:');
    for (const r of runs) console.error(`        run ${r.run}  ${r.sha256}`);
    process.exit(1);
  }

  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    log('');
    log(
      `  PASS  ${runs.length} image(s), first ${summary.firstRunSeconds}s` +
        (summary.warmSeconds !== null ? `, warm avg ${summary.warmSeconds}s/image` : '') +
        (REPEAT > 1 ? `, determinism ${deterministic ? 'HELD' : 'BROKEN'}` : ''),
    );
    log(`        ${runs[0].file}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n  FAIL  ${err?.stack ?? err}\n`);
  process.exit(1);
});
