import {
  type AnySettingDescriptor,
  KNOWN_MODELS,
  SETTINGS_REGISTRY,
  SettingDescriptorMeta,
  describePricing,
  modelRef,
} from '@rv/contracts';

import type { SettingModelChoice, SettingScope } from '../schemas/settings';

/**
 * The fixture data, derived from the real registry rather than imitating one.
 *
 * This file used to *be* a settings registry: twenty hand-written descriptors in a
 * shape the studio had guessed. That was the right thing to do while nothing upstream
 * declared them and the wrong thing to keep, because a hand-written registry drifts
 * from the real one in exactly the way architecture 7b exists to prevent - the screen
 * looks finished against keys the code does not read.
 *
 * So nothing here declares a setting. `SETTING_DESCRIPTORS` is `SETTINGS_REGISTRY`
 * serialised, `MODEL_CHOICES` is `KNOWN_MODELS` mapped, and the only hand-written thing
 * left is {@link SETTING_LAYER_VALUES} - which is *data*, not declaration: the rows a
 * database and a `.env` file would hold on a machine that has been used.
 */

/**
 * The registry, in the form that crosses the wire.
 *
 * Parsed through `SettingDescriptorMeta` rather than spread and trusted, for the same
 * reason `apps/api` does it: the schema is the boundary, and a declaration that cannot
 * be serialised should fail here rather than as a blank row in a browser.
 *
 * `schema` and `default` are stripped first because `SettingDescriptorMeta` is a
 * `strictObject` and would refuse them - which is the correct refusal. A Zod schema
 * cannot be JSON, and a client that received one would start executing it; `default` is
 * absent from the wire on purpose, because "this value is the built-in default" is
 * already answered by `origin === 'default'` and a second copy could disagree with it.
 */
function serialise(descriptor: AnySettingDescriptor): SettingDescriptorMeta {
  const { schema: _schema, default: _default, ...meta } = descriptor;
  return SettingDescriptorMeta.parse(meta);
}

export const SETTING_DESCRIPTORS: readonly SettingDescriptorMeta[] =
  SETTINGS_REGISTRY.map(serialise);

/**
 * The catalogue a `model-picker` chooses from, from the models research verified.
 *
 * `ref` is carried alongside `provider` and `model` because `provider:model` is the
 * form that lands in the cost ledger, and a client that assembled it itself would be a
 * second place the separator is decided. `pricing` is the same one-line summary the
 * registry puts in each option's hint, so the picker can answer "what will this cost"
 * in the same glance as "which model".
 */
export const MODEL_CHOICES: readonly SettingModelChoice[] = KNOWN_MODELS.map((model) => ({
  ref: modelRef(model.provider, model.id),
  provider: model.provider,
  model: model.id,
  label: model.label,
  capabilities: [...model.capabilities],
  free: model.pricing.free,
  pricing: describePricing(model.pricing),
}));

/**
 * What each layer actually holds. Everything absent is inherited, which is the point.
 *
 * Chosen so the settings screen exercises every state it can be in rather than the
 * happy one, because each of these is a rendering path that is otherwise never taken:
 *
 * - **A value at every layer.** `machine` is `.env`, `global` is the default view's own
 *   layer, and `project`/`run` only enter the stack when the request names one - so the
 *   scoped views have something to show too.
 * - **A shadowed key.** `budget.perDayNanoUsd` is set in `.env` *and* globally, so the
 *   global row is "set here" while the machine value is listed as overruled - and
 *   clearing it falls back to `.env` rather than to the built-in default, which is the
 *   only way to see that the chain has four links and not two.
 *   `model.qualityTier` is set globally and again at run scope, so a run-scoped view
 *   shows the opposite case: a layer that holds a value and lost.
 * - **A secret present and a secret absent.** OpenRouter's key is set; Gemini's is the
 *   empty string `.env.example` ships, which is *not* "set" - reporting it as set would
 *   tell the operator a lane is configured that will fail unauthenticated on the next
 *   call.
 * - **A stored value that no longer parses.** `render.backend` holds a backend name
 *   that is not in the union, the way a row written by an older build would. The
 *   resolver skips it and reports it, and the screen says so instead of silently
 *   showing the fallback.
 * - **A dependency that is satisfied.** `image.comfyui.remote` is on, which is the
 *   second condition `image.comfyui.authToken` needs before it is shown at all.
 */
export const SETTING_LAYER_VALUES: Readonly<
  Record<SettingScope, Readonly<Record<string, unknown>>>
> = {
  machine: {
    'provider.ollama.host': 'http://127.0.0.1:11434',
    'provider.openrouter.apiKey': 'sk-or-v1-fixture-key-never-leaves-the-server',
    // Blank, exactly as `.env.example` ships it: present in the file, not configured.
    'provider.gemini.apiKey': '',
    'image.comfyui.host': 'http://127.0.0.1:8288',
    'image.comfyui.remote': true,
    'render.concurrency': 6,
    'runtime.logLevel': 'trace',
    'runtime.apiPort': 3100,
    'runtime.workspaceDir': './workspace',
    'budget.perDayNanoUsd': 25_000_000_000,
  },
  global: {
    'budget.perDayNanoUsd': 40_000_000_000,
    'model.qualityTier': 'preview',
    'interface.direction': 'rtl',
    'delivery.formats': ['yt-1080p', 'shorts-9x16'],
    // Written by a build that spelled the backend differently. Skipped and reported.
    'render.backend': 'pixi-playwright-legacy',
  },
  project: {
    'image.lane': 'colab',
    'provider.ollama.textModel': 'llama3.2:latest',
    'budget.perProjectNanoUsd': 12_000_000_000,
    'model.routingPolicy': 'cheapest',
  },
  run: {
    'model.qualityTier': 'final',
    'budget.perRunNanoUsd': 2_500_000_000,
    'model.stage.story': 'openrouter:z-ai/glm-5.2:free',
  },
};
