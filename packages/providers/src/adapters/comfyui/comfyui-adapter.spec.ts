import { describe, expect, it } from 'vitest';
import { ZERO_USD, isErr, isOk, millis } from '@rv/shared-kernel';

import { supportsPartsSheet } from '../../ports/parts-sheet';

import { FetchStub } from '../../__fixtures__/fetch-stub';
import {
  COMFY_PROMPT_ID,
  comfy as fixture,
  pngBytes,
  pngSha256,
} from '../../__fixtures__/responses';
import { fixedClock } from '../../__fixtures__/support';
import { readWorkflow } from './__fixtures__/workflows';
import {
  COMFYUI_CAPABILITIES,
  COMFYUI_DEFAULT_BASE_URL,
  COMFYUI_MAX_DIMENSION,
  COMFYUI_PARTS_SHEET_DEFAULTS,
  ComfyUiAdapter,
  type ComfyWorkflowSet,
} from './comfyui-adapter';
import {
  COMFY_OPTIONAL_WORKFLOW_FILES,
  COMFY_WORKFLOW_FILES,
  loadComfyWorkflows,
} from './load-workflows';
import { WORKFLOW_DIR } from './__fixtures__/workflows';

const workflows: ComfyWorkflowSet = {
  txt2img: readWorkflow(COMFY_WORKFLOW_FILES.txt2img),
  img2img: readWorkflow(COMFY_WORKFLOW_FILES.img2img),
  partsSheet: readWorkflow(COMFY_OPTIONAL_WORKFLOW_FILES.partsSheet),
};

/** A deployment that never got the optional graph. */
const withoutSheet: ComfyWorkflowSet = {
  txt2img: workflows.txt2img,
  img2img: workflows.img2img,
};

const SHEET = {
  subject: 'a two-wheeled wooden handcart',
  parts: ['cart frame', 'oil-can load', 'front wheel', 'rear wheel'],
  style: 'flat vector illustration, muted earth palette',
  background: 'flat neutral light grey',
  grid: { cols: 2, rows: 2 },
} as const;

function happyStub(marker = 1): FetchStub {
  return new FetchStub()
    .on('/prompt', { json: fixture.queued })
    .on('/history/', { json: fixture.completed() })
    .on('/view', { bytes: pngBytes(marker) })
    .on('/upload/image', { json: fixture.uploaded });
}

function adapterWith(
  stub: FetchStub,
  overrides: Partial<ConstructorParameters<typeof ComfyUiAdapter>[0]> = {},
): ComfyUiAdapter {
  return new ComfyUiAdapter({
    workflows,
    fetch: stub.fetch,
    clock: fixedClock(),
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}

describe('ComfyUiAdapter identity', () => {
  it('defaults to port 8288, not 8188', () => {
    // 8188 falls inside a Windows reserved TCP exclusion range (8163-8262, WinNAT) on
    // this machine and cannot be bound. See tools/comfy-workflows/README.md.
    expect(COMFYUI_DEFAULT_BASE_URL).toBe('http://127.0.0.1:8288');
    expect(COMFYUI_DEFAULT_BASE_URL).not.toContain('8188');
  });

  it('names the checkpoint as the model, because that is what the output depends on', () => {
    expect(adapterWith(new FetchStub()).modelRef).toBe('comfyui:dreamshaper_8.safetensors');
    expect(
      adapterWith(new FetchStub(), { defaults: { checkpoint: 'other.safetensors' } }).modelRef,
    ).toBe('comfyui:other.safetensors');
  });

  it('declares image generation and edit only', () => {
    expect(adapterWith(new FetchStub()).capabilities).toEqual(COMFYUI_CAPABILITIES);
  });
});

describe('ComfyUiAdapter.generateImage', () => {
  it('follows POST /prompt -> poll /history -> GET /view', async () => {
    const stub = happyStub(2);
    const outcome = await adapterWith(stub).generateImage({
      prompt: 'a brass pocket watch',
      seed: 424242,
      size: { width: 512, height: 512 },
    });

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      expect(outcome.value.images).toHaveLength(1);
      expect(outcome.value.images[0]?.data).toEqual(pngBytes(2));
      expect(outcome.value.images[0]?.sha256).toBe(pngSha256(2));
      expect(outcome.value.images[0]?.seed).toBe(424242);
      // Local inference: the ledger row for this prices to exactly zero.
      expect(outcome.value.usage.images).toEqual({
        count: 1,
        resolution: { width: 512, height: 512 },
      });
    }

    expect(stub.requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/prompt',
      `/history/${COMFY_PROMPT_ID}`,
      '/view',
    ]);
  });

  it('substitutes the prompt, seed, width and height into the graph', async () => {
    const stub = happyStub();
    await adapterWith(stub).generateImage({
      prompt: 'a fox',
      negativePrompt: 'blurry',
      seed: 99,
      size: { width: 768, height: 768 },
    });

    const graph = (
      stub.requestsFor('/prompt')[0]?.json as {
        prompt: Record<string, { inputs: Record<string, unknown> }>;
      }
    ).prompt;
    expect(graph['4']?.inputs.text).toBe('a fox');
    expect(graph['5']?.inputs.text).toBe('blurry');
    expect(graph['6']?.inputs.width).toBe(768);
    expect(graph['6']?.inputs.height).toBe(768);
    expect(graph['7']?.inputs.seed).toBe(99);
    // Numbers, not strings: ComfyUI type-checks INT/FLOAT node inputs.
    expect(typeof graph['7']?.inputs.steps).toBe('number');
  });

  it('returns identical bytes for the same seed and prompt', async () => {
    const first = await adapterWith(happyStub(4)).generateImage({ prompt: 'x', seed: 1 });
    const second = await adapterWith(happyStub(4)).generateImage({ prompt: 'x', seed: 1 });

    expect(isOk(first) && isOk(second)).toBe(true);
    if (isOk(first) && isOk(second)) {
      expect(first.value.images[0]?.sha256).toBe(second.value.images[0]?.sha256);
    }
  });

  it('declines above 1024px per axis instead of OOM-ing the 6 GB card', async () => {
    // An out-of-memory kill takes the whole ComfyUI process with it, so every queued
    // job dies with the oversized one. A refusal costs the router one failover.
    const stub = happyStub();
    const outcome = await adapterWith(stub).generateImage({
      prompt: 'x',
      size: { width: 1280, height: 1280 },
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.kind).toBe('unsupported');
      expect(outcome.error.retryable).toBe(false);
      expect(String(outcome.error.context.capability)).toContain('6 GB');
      expect(String(outcome.error.context.capability)).toContain(String(COMFYUI_MAX_DIMENSION));
    }
    expect(stub.requests).toHaveLength(0);
  });

  it('allows exactly 1024px, which the README measures at 95 % of the card', async () => {
    const outcome = await adapterWith(happyStub()).generateImage({
      prompt: 'x',
      size: { width: 1024, height: 1024 },
    });
    expect(isOk(outcome)).toBe(true);
  });

  it('refuses reference conditioning rather than silently ignoring it', async () => {
    // `--disable-all-custom-nodes` is on for reproducibility, so there is no
    // IP-Adapter node to route references through.
    const outcome = await adapterWith(happyStub()).generateImage({
      prompt: 'x',
      references: [{ mimeType: 'image/png', data: pngBytes(1) }],
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.kind).toBe('unsupported');
  });
});

describe('ComfyUiAdapter.editImage', () => {
  it('uploads the base image and runs the img2img graph at the requested denoise', async () => {
    const stub = happyStub(8);
    const outcome = await adapterWith(stub).editImage({
      base: { mimeType: 'image/png', data: pngBytes(1) },
      instruction: 'winter coat',
      strength: 0.35,
      seed: 5,
    });

    expect(isOk(outcome)).toBe(true);
    expect(stub.requestsFor('/upload/image')).toHaveLength(1);

    const graph = (
      stub.requestsFor('/prompt')[0]?.json as {
        prompt: Record<string, { inputs: Record<string, unknown> }>;
      }
    ).prompt;
    expect(graph['10']?.inputs.image).toBe('rivayat-base.png');
    expect(graph['7']?.inputs.denoise).toBe(0.35);
    expect(graph['4']?.inputs.text).toBe('winter coat, winter coat');
  });

  it('refuses a masked edit rather than dropping the mask', async () => {
    const outcome = await adapterWith(happyStub()).editImage({
      base: { mimeType: 'image/png', data: pngBytes(1) },
      mask: { mimeType: 'image/png', data: pngBytes(2) },
      instruction: 'x',
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.kind).toBe('unsupported');
  });

  it('reports an upload that returned no filename', async () => {
    const stub = new FetchStub().on('/upload/image', { json: { subfolder: '' } });
    const outcome = await adapterWith(stub).editImage({
      base: { mimeType: 'image/png', data: pngBytes(1) },
      instruction: 'x',
    });
    expect(isErr(outcome) && outcome.error.retryable).toBe(true);
  });

  it('reports an upload body that is not an object', async () => {
    const stub = new FetchStub().on('/upload/image', { json: 'oops' });
    const outcome = await adapterWith(stub).editImage({
      base: { mimeType: 'image/png', data: pngBytes(1) },
      instruction: 'x',
    });
    expect(isErr(outcome)).toBe(true);
  });

  it('qualifies the filename with a subfolder when ComfyUI used one', async () => {
    const stub = happyStub();
    const withSubfolder = new FetchStub()
      .on('/upload/image', { json: { name: 'b.png', subfolder: 'refs', type: 'input' } })
      .on('/prompt', { json: fixture.queued })
      .on('/history/', { json: fixture.completed() })
      .on('/view', { bytes: pngBytes(1) });

    await adapterWith(withSubfolder).editImage({
      base: { mimeType: 'image/png', data: pngBytes(1) },
      instruction: 'x',
    });

    const graph = (
      withSubfolder.requestsFor('/prompt')[0]?.json as {
        prompt: Record<string, { inputs: Record<string, unknown> }>;
      }
    ).prompt;
    expect(graph['10']?.inputs.image).toBe('refs/b.png');
    expect(stub.requests).toHaveLength(0);
  });
});

describe('ComfyUiAdapter failure paths', () => {
  it('returns a retryable ProviderError when ComfyUI is not running', async () => {
    const stub = new FetchStub().on('/prompt', { throws: new TypeError('fetch failed') });
    const outcome = await adapterWith(stub).generateImage({ prompt: 'x' });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.kind).toBe('provider');
      // Retryable, so the router fails over to the cloud lane.
      expect(outcome.error.retryable).toBe(true);
    }
  });

  it('refuses permanently when ComfyUI rejects the graph outright', async () => {
    // Graph validation failures come back as a 400 carrying `node_errors`.
    const stub = new FetchStub().on('/prompt', { status: 400, json: fixture.rejected });
    const outcome = await adapterWith(stub).generateImage({ prompt: 'x' });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      // A workflow bug, not a blip: the same graph will be rejected again.
      expect(outcome.error.kind).toBe('provider');
      expect(outcome.error.retryable).toBe(false);
    }
  });

  it('refuses permanently when an accepted prompt still carries node_errors', async () => {
    const stub = new FetchStub().on('/prompt', {
      json: {
        ...fixture.queued,
        node_errors: (fixture.rejected as { node_errors: unknown }).node_errors,
      },
    });
    const outcome = await adapterWith(stub).generateImage({ prompt: 'x' });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.retryable).toBe(false);
      expect(outcome.error.context.nodeErrors).toBeDefined();
    }
  });

  it('reports a /prompt body with no prompt_id', async () => {
    const stub = new FetchStub().on('/prompt', { json: { number: 1 } });
    const outcome = await adapterWith(stub).generateImage({ prompt: 'x' });
    expect(isErr(outcome) && outcome.error.retryable).toBe(true);
  });

  it('surfaces an execution error from /history permanently', async () => {
    const stub = new FetchStub()
      .on('/prompt', { json: fixture.queued })
      .on('/history/', { json: fixture.failed });

    const outcome = await adapterWith(stub).generateImage({ prompt: 'x' });
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.retryable).toBe(false);
  });

  it('polls until the prompt completes', async () => {
    const stub = new FetchStub()
      .on('/prompt', { json: fixture.queued })
      .once('/history/', { json: fixture.pending })
      .once('/history/', { json: fixture.pending })
      .on('/history/', { json: fixture.completed() })
      .on('/view', { bytes: pngBytes(1) });

    const waits: number[] = [];
    const outcome = await adapterWith(stub, {
      pollIntervalMs: 25,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    }).generateImage({ prompt: 'x' });

    expect(isOk(outcome)).toBe(true);
    expect(stub.requestsFor('/history/')).toHaveLength(3);
    expect(waits).toEqual([25, 25]);
  });

  it('times out rather than polling forever', async () => {
    const clock = fixedClock();
    const stub = new FetchStub()
      .on('/prompt', { json: fixture.queued })
      .on('/history/', { json: fixture.pending });

    const outcome = await adapterWith(stub, {
      clock,
      generationTimeoutMs: 100,
      pollIntervalMs: 50,
      sleep: (ms) => {
        clock.advance(millis(ms));
        return Promise.resolve();
      },
    }).generateImage({ prompt: 'x' });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.kind).toBe('timeout');
      expect(outcome.error.retryable).toBe(true);
    }
  });

  it('reports a completed prompt that saved nothing', async () => {
    const stub = new FetchStub().on('/prompt', { json: fixture.queued }).on('/history/', {
      json: { [COMFY_PROMPT_ID]: { status: { completed: true }, outputs: {} } },
    });

    const outcome = await adapterWith(stub).generateImage({ prompt: 'x' });
    expect(isErr(outcome) && outcome.error.retryable).toBe(false);
  });

  it('reports a malformed /history body', async () => {
    const stub = new FetchStub()
      .on('/prompt', { json: fixture.queued })
      .on('/history/', { json: { [COMFY_PROMPT_ID]: { outputs: 'nope' } } });

    const outcome = await adapterWith(stub).generateImage({ prompt: 'x' });
    expect(isErr(outcome) && outcome.error.retryable).toBe(true);
  });

  it('returns CancelledError without issuing a request when already aborted', async () => {
    const stub = happyStub();
    const controller = new AbortController();
    controller.abort();

    const outcome = await adapterWith(stub).generateImage({
      prompt: 'x',
      signal: controller.signal,
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.kind).toBe('cancelled');
    expect(stub.requests).toHaveLength(0);
  });

  it('fails when a placeholder the graph needs was never supplied', async () => {
    const outcome = await adapterWith(happyStub(), {
      workflows: { txt2img: { '4': { inputs: { text: '{{unknown_thing}}' } } }, img2img: {} },
    }).generateImage({ prompt: 'x' });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.kind).toBe('validation');
  });
});

describe('ComfyUiAdapter.generatePartsSheet', () => {
  it('fills every slot of the parts-sheet graph, and keeps the ints as ints', async () => {
    const stub = happyStub();
    const outcome = await adapterWith(stub).generatePartsSheet({
      ...SHEET,
      negativePrompt: 'blurry',
      size: { width: 768, height: 512 },
      seed: 7,
    });

    expect(isOk(outcome)).toBe(true);
    const graph = (
      stub.requestsFor('/prompt')[0]?.json as {
        prompt: Record<string, { inputs: Record<string, unknown> }>;
      }
    ).prompt;
    const positive = String(graph['4']?.inputs.text);

    // The scaffold is the workflow's, and it survives - a caller cannot prompt it away.
    expect(positive).toContain('exploded view item sheet');
    expect(positive).toContain('a two-wheeled wooden handcart');
    expect(positive).toContain('cart frame, oil-can load, front wheel, rear wheel');
    expect(positive).toContain('flat neutral light grey background');
    expect(positive).toContain('2 by 2 grid');
    // The caller's negative is prepended to the fixed separability tail, not replacing it.
    expect(String(graph['5']?.inputs.text)).toMatch(/^blurry, .*single assembled figure/);
    expect(graph['6']?.inputs.width).toBe(768);
    expect(graph['7']?.inputs.seed).toBe(7);
    expect(graph['7']?.inputs.steps).toBe(COMFYUI_PARTS_SHEET_DEFAULTS.steps);
    expect(graph['7']?.inputs.cfg).toBe(COMFYUI_PARTS_SHEET_DEFAULTS.cfg);
  });

  it('leaves no placeholder behind - the graph is POSTed or nothing is', async () => {
    const stub = happyStub();
    await adapterWith(stub).generatePartsSheet(SHEET);
    expect(JSON.stringify(stub.requestsFor('/prompt')[0]?.json)).not.toContain('{{');
  });

  it('declares itself unable, and refuses, when the graph was never loaded', async () => {
    const stub = happyStub();
    const adapter = adapterWith(stub, { workflows: withoutSheet });

    expect(adapter.servesPartsSheet).toBe(false);
    expect(supportsPartsSheet(adapter)).toBe(false);

    const outcome = await adapter.generatePartsSheet(SHEET);
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.code).toBe('UNSUPPORTED_CAPABILITY');
    // Refused before anything was queued.
    expect(stub.requests).toHaveLength(0);
  });

  it('refuses a sheet with no components rather than asking for an empty grid', async () => {
    const stub = happyStub();
    const outcome = await adapterWith(stub).generatePartsSheet({ ...SHEET, parts: [] });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.kind).toBe('validation');
    expect(stub.requests).toHaveLength(0);
  });

  it('applies the same 1024px ceiling as an ordinary generation', async () => {
    const stub = happyStub();
    const outcome = await adapterWith(stub).generatePartsSheet({
      ...SHEET,
      size: { width: COMFYUI_MAX_DIMENSION + 256, height: 512 },
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('is recognised by the guard when the graph is present', () => {
    const adapter = adapterWith(new FetchStub());
    expect(adapter.servesPartsSheet).toBe(true);
    expect(supportsPartsSheet(adapter)).toBe(true);
  });
});

describe('ComfyUiAdapter.quoteImage', () => {
  it('quotes free, because local inference has no metered cost', () => {
    const quote = adapterWith(new FetchStub()).quoteImage({
      size: { width: 1024, height: 1024 },
    });

    expect(quote.kind).toBe('free');
    if (quote.kind !== 'free') return;
    expect(quote.nanoUsd).toBe(ZERO_USD);
    expect(quote.modelRef).toBe('comfyui:dreamshaper_8.safetensors');
  });

  it('does not vary with size or count - the answer is a fact, not an estimate', () => {
    const adapter = adapterWith(new FetchStub());
    expect(adapter.quoteImage({ size: { width: 512, height: 512 } })).toEqual(
      adapter.quoteImage({ size: { width: 1024, height: 1024 }, count: 4 }),
    );
  });
});

describe('loadComfyWorkflows', () => {
  it('reads both graphs from tools/comfy-workflows', async () => {
    const outcome = await loadComfyWorkflows(WORKFLOW_DIR);
    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      expect(outcome.value.txt2img).toBeTypeOf('object');
      expect(outcome.value.img2img).toBeTypeOf('object');
    }
  });

  it('returns a typed failure rather than throwing when a graph is missing', async () => {
    const outcome = await loadComfyWorkflows('/definitely/not/here');
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.kind).toBe('validation');
  });

  it('picks the optional parts-sheet graph up when it is there', async () => {
    const outcome = await loadComfyWorkflows(WORKFLOW_DIR);
    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) expect(outcome.value.partsSheet).toBeTypeOf('object');
  });
});
