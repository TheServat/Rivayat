/**
 * Every option the user can change, declared once.
 *
 * This is the list architecture 7b promises exists. Three consumers read it and none of
 * them keeps its own copy: the settings screen renders a control per entry, the API
 * validates a patch with the entry's own `schema`, and `@rv/settings` resolves the
 * entry's `key` through the layer stack. A setting that exists here is reachable from
 * all three; a setting removed here disappears from all three at once.
 *
 * **Choices are derived, never retyped.** Every model list comes from `KNOWN_MODELS`,
 * every delivery format from `FORMAT_PRESETS`, every stage from `PipelineStageKey`,
 * every locale from `Locale`. That is not tidiness - it is the mechanism by which a
 * model that leaves the catalogue vanishes from the picker without anyone remembering
 * to delete it. Where a choice needs Persian text the catalogue cannot supply, the
 * translation table is a `Record` over the source union, so removing a member of the
 * union is a compile error here rather than a blank row in the UI.
 *
 * **The `.env` binding is part of the declaration.** A machine-scope setting names the
 * variable it reads, and `env-mapping.spec.ts` in `@rv/settings` asserts that the set of
 * `RV_*` names here and the set in `.env.example` are the same set. A typo'd env var
 * that silently does nothing is the exact failure this registry exists to prevent, and
 * that one test is what keeps the three surfaces from drifting.
 */

import { LOG_LEVELS } from '@rv/shared-kernel';
import { z } from 'zod';

import { Locale, type LocalisedText, NanoUsdAmount, NonEmptyString } from '../primitives/common';
import {
  type Capability,
  KNOWN_MODELS,
  ModelRef,
  type PipelineStageKey,
  type ProviderKind,
  ProviderModelId,
  QualityTier,
  RoutingPolicy,
  describePricing,
  modelRef,
} from '../provider/capability';
import { BudgetAction } from '../provider/usage';
import { FORMAT_PRESETS, FormatProfileId } from '../render/format';
import { RenderBackend } from '../render/render-job';
import {
  type AnySettingDescriptor,
  type EnvVarName,
  type SettingDescriptor,
  type SettingGroup,
  type SettingOption,
} from './descriptor';
import { ImageLane, TextDirection } from './values';

// ── derivation helpers ──────────────────────────────────────────────────────

/**
 * Turns a Zod enum's own option list into UI choices.
 *
 * Taking the values from `schema.options` rather than from the label table is what
 * makes "every enum's options match its schema's accepted values" true by construction:
 * the table supplies translations for values the schema already accepts, and a table
 * missing one is a compile error because `Record<T, LocalisedText>` is exhaustive.
 */
function enumOptions<T extends string>(
  values: readonly T[],
  labels: Readonly<Record<T, LocalisedText>>,
): SettingOption[] {
  return values.map((value) => ({ value, label: labels[value] }));
}

/**
 * Catalogue models as `provider:model` references.
 *
 * The `hint` is the model's real price summary, so the picker answers "what will this
 * cost" in the same glance as "which model" - which is the question the owner actually
 * has when pinning a stage to a cloud model.
 */
function modelRefOptions(
  capability: Capability,
  providers: readonly ProviderKind[],
): SettingOption[] {
  return KNOWN_MODELS.filter(
    (model) => providers.includes(model.provider) && model.capabilities.includes(capability),
  ).map((model) => ({
    value: modelRef(model.provider, model.id),
    // Model names are proper nouns; translating "Gemini 3 Flash" would be worse.
    label: { fa: model.label, en: model.label },
    hint: describePricing(model.pricing),
  }));
}

/** Catalogue models for one provider, as bare provider-native ids. */
function modelIdOptions(provider: ProviderKind, capability: Capability): SettingOption[] {
  return KNOWN_MODELS.filter(
    (model) => model.provider === provider && model.capabilities.includes(capability),
  ).map((model) => ({
    value: model.id,
    label: { fa: model.label, en: model.label },
    hint: describePricing(model.pricing),
  }));
}

/** Delivery formats, straight from the verified platform table. */
function formatOptions(): SettingOption[] {
  return Object.values(FORMAT_PRESETS).map((profile) => ({
    value: profile.id,
    label: { fa: profile.label, en: profile.label },
    hint: `${String(profile.size.width)}x${String(profile.size.height)} - ${profile.aspectRatio}`,
  }));
}

// ── translation tables ──────────────────────────────────────────────────────

const STAGE_LABELS = {
  intake: { fa: 'دریافت ایده', en: 'Intake' },
  style: { fa: 'سبک بصری', en: 'Style' },
  story: { fa: 'داستان', en: 'Story' },
  cast: { fa: 'شخصیت‌ها', en: 'Cast' },
  world: { fa: 'جهان داستان', en: 'World' },
  resolve: { fa: 'تخصیص دارایی', en: 'Resolve' },
  produce: { fa: 'تولید تصویر', en: 'Produce' },
  sequence: { fa: 'توالی نماها', en: 'Sequence' },
  choreograph: { fa: 'طراحی حرکت', en: 'Choreograph' },
  preview: { fa: 'پیش‌نمایش', en: 'Preview' },
  render: { fa: 'رندر', en: 'Render' },
  deliver: { fa: 'تحویل', en: 'Deliver' },
} as const satisfies Record<PipelineStageKey, LocalisedText>;

/**
 * Which capability a stage's model has to have.
 *
 * Every text call in the system goes through `StructuredCall` (CLAUDE.md 6), so
 * `structured-generation` is the honest requirement for the prose stages rather than
 * bare `text-generation`. Only two stages differ: `produce` makes images, and `preview`
 * runs the vision quality gate.
 */
const STAGE_CAPABILITY = {
  intake: 'structured-generation',
  style: 'structured-generation',
  story: 'structured-generation',
  cast: 'structured-generation',
  world: 'structured-generation',
  resolve: 'structured-generation',
  produce: 'image-generation',
  sequence: 'structured-generation',
  choreograph: 'structured-generation',
  preview: 'vision-scoring',
  render: 'structured-generation',
  deliver: 'structured-generation',
} as const satisfies Record<PipelineStageKey, Capability>;

/**
 * Which providers may fill a stage's slot.
 *
 * The owner's requirement is Ollama, Gemini or OpenRouter chosen independently per
 * stage. `produce` adds `comfyui` because the free local image lane is a provider like
 * any other, and drops `ollama`, which generates no images.
 */
const TEXT_PROVIDERS: readonly ProviderKind[] = ['ollama', 'gemini', 'openrouter'];
const IMAGE_PROVIDERS: readonly ProviderKind[] = ['comfyui', 'gemini', 'openrouter'];

function stageProviders(stage: PipelineStageKey): readonly ProviderKind[] {
  return STAGE_CAPABILITY[stage] === 'image-generation' ? IMAGE_PROVIDERS : TEXT_PROVIDERS;
}

// ── per-stage model selection ───────────────────────────────────────────────

/**
 * The owner's explicit requirement, generalised by architecture 5 to every stage:
 * "cheap local model for bulk extraction, strong cloud model for the creative beats" is
 * a per-stage judgement only the author can make.
 *
 * `null` is the default and means "let the router decide from the tier and the policy".
 * It is a real answer, not an empty one: pinning every stage by hand is how a routing
 * table stops reflecting the price list.
 */
function stageModelSetting(stage: PipelineStageKey): SettingDescriptor<ModelRef | null> {
  const label = STAGE_LABELS[stage];
  const capability = STAGE_CAPABILITY[stage];
  return {
    key: `model.stage.${stage}`,
    group: 'models',
    label: { fa: `مدل مرحله ${label.fa}`, en: `${label.en} stage model` },
    help: {
      fa: 'مدلی که این مرحله با آن اجرا می‌شود. خالی بگذارید تا مسیریاب بر اساس سطح کیفیت و سیاست مسیریابی انتخاب کند.',
      en: 'The model this stage runs on. Leave empty to let the router choose from the quality tier and routing policy.',
    },
    scope: 'run',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: {
      kind: 'model-picker',
      capability,
      providers: [...stageProviders(stage)],
      allowCustom: true,
      nullable: true,
    },
    options: modelRefOptions(capability, stageProviders(stage)),
    schema: ModelRef.nullable(),
    default: null,
  };
}

// ── per-provider role models ────────────────────────────────────────────────

interface RoleModelInput {
  readonly key: string;
  readonly label: LocalisedText;
  readonly help: LocalisedText;
  readonly provider: ProviderKind;
  readonly capability: Capability;
  readonly env: EnvVarName;
  readonly fallback: string;
}

/**
 * A provider's default model for one role.
 *
 * Open-schema on purpose: the value is a `ProviderModelId`, not an enum over the
 * catalogue. `KNOWN_MODELS` is *seed* data - Ollama serves whatever the operator pulled,
 * and OpenRouter's catalogue is synced live - so a closed enum here would reject a model
 * that genuinely exists on the machine. The picker seeds from the catalogue and
 * `allowCustom` admits the rest.
 */
function roleModelSetting(input: RoleModelInput): SettingDescriptor<ProviderModelId> {
  return {
    key: input.key,
    group: 'providers',
    label: input.label,
    help: input.help,
    scope: 'project',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: {
      kind: 'model-picker',
      capability: input.capability,
      providers: [input.provider],
      allowCustom: true,
    },
    options: modelIdOptions(input.provider, input.capability),
    env: { name: input.env, format: 'string' },
    schema: ProviderModelId,
    default: input.fallback,
  };
}

// ── the declarations ────────────────────────────────────────────────────────

const CENT_NANO_USD = 10_000_000;

/**
 * The registry.
 *
 * A record rather than an array so `SettingKey` is the union of the literal keys and a
 * typo in `resolve('provider.olama.host')` is a compile error rather than a silent
 * fallback to the default. The twelve per-stage entries are spelled out rather than
 * generated into the object, because a mapped type over `PipelineStageKey` makes a
 * missing or surplus stage a compile error - which is stronger than the runtime check a
 * generated record would need - while every entry's *content* still comes from the one
 * factory above.
 */
export const SETTINGS = {
  // ── providers: endpoints, keys, and each provider's default model per role ──

  'provider.ollama.host': {
    key: 'provider.ollama.host',
    group: 'providers',
    label: { fa: 'آدرس اولاما', en: 'Ollama host' },
    help: {
      fa: 'نشانی سرویس محلی اولاما. لِین رایگان و پیش‌فرض برای همهٔ کارهای متنی است.',
      en: 'Where the local Ollama service listens. This is the free default lane for every text job.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'url', placeholder: 'http://127.0.0.1:11434' },
    env: { name: 'OLLAMA_HOST', format: 'string' },
    schema: z.url(),
    default: 'http://127.0.0.1:11434',
  } satisfies SettingDescriptor<string>,

  'provider.ollama.textModel': roleModelSetting({
    key: 'provider.ollama.textModel',
    label: { fa: 'مدل متنی اولاما', en: 'Ollama text model' },
    help: {
      fa: 'مدل پیش‌فرض اولاما برای نوشتن و استخراج ساختاریافته.',
      en: "Ollama's default model for drafting prose and structured extraction.",
    },
    provider: 'ollama',
    capability: 'structured-generation',
    env: 'RV_OLLAMA_TEXT_MODEL',
    fallback: 'qwen3.5:latest',
  }),

  'provider.ollama.fastModel': roleModelSetting({
    key: 'provider.ollama.fastModel',
    label: { fa: 'مدل سریع اولاما', en: 'Ollama fast model' },
    help: {
      fa: 'مدل کوچک برای کارهای پرتکرار و کم‌اهمیت، مثل برچسب‌گذاری و خلاصه‌های کوتاه.',
      en: 'The small model for high-volume, low-stakes work: tagging, short summaries.',
    },
    provider: 'ollama',
    capability: 'structured-generation',
    env: 'RV_OLLAMA_FAST_MODEL',
    fallback: 'qwen3:1.7b',
  }),

  'provider.ollama.visionModel': roleModelSetting({
    key: 'provider.ollama.visionModel',
    label: { fa: 'مدل بینایی اولاما', en: 'Ollama vision model' },
    help: {
      fa: 'مدل محلی برای امتیازدهی به تصاویر تولیدشده در دروازهٔ کیفیت.',
      en: 'The local model that scores generated images at the quality gate.',
    },
    provider: 'ollama',
    capability: 'structured-generation',
    env: 'RV_OLLAMA_VISION_MODEL',
    fallback: 'gemma4:26b',
  }),

  'provider.ollama.embedModel': {
    key: 'provider.ollama.embedModel',
    group: 'providers',
    label: { fa: 'مدل بردارسازی اولاما', en: 'Ollama embedding model' },
    help: {
      fa: 'مدل تولید بردار برای نمایهٔ معنایی. تغییر آن نمایهٔ موجود را بی‌اعتبار می‌کند، چون بردارهای دو مدل مختلف قابل مقایسه نیستند.',
      en: 'The model that produces vectors for the semantic index. Changing it invalidates the existing index: vectors from two different models are not comparable.',
    },
    scope: 'project',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    // A text field, not a picker: `nomic-embed-text` is not in `KNOWN_MODELS` and no
    // embedding model is, because research names none. An empty picker is worse than
    // an honest text field.
    control: { kind: 'text', placeholder: 'nomic-embed-text' },
    env: { name: 'RV_OLLAMA_EMBED_MODEL', format: 'string' },
    schema: ProviderModelId,
    default: 'nomic-embed-text',
  } satisfies SettingDescriptor<ProviderModelId>,

  'provider.gemini.apiKey': {
    key: 'provider.gemini.apiKey',
    group: 'providers',
    label: { fa: 'کلید جِمینای', en: 'Gemini API key' },
    help: {
      fa: 'بدون این کلید، لِین ابری گوگل در دسترس نیست و مسیریاب آن را دور می‌زند. سطح رایگان فقط شامل مدل‌های متنی است.',
      en: 'Without it the Google cloud lane is unreachable and the router routes around it. The free tier covers text models only.',
    },
    scope: 'machine',
    secret: true,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'secret' },
    env: { name: 'GEMINI_API_KEY', format: 'string' },
    schema: z.string().max(500),
    default: '',
  } satisfies SettingDescriptor<string>,

  'provider.gemini.textModel': roleModelSetting({
    key: 'provider.gemini.textModel',
    label: { fa: 'مدل متنی جِمینای', en: 'Gemini text model' },
    help: {
      fa: 'مدل پیش‌فرض جِمینای برای کارهای متنی. مدل‌های Flash در سطح رایگان هستند.',
      en: "Gemini's default text model. The Flash models are on the free tier.",
    },
    provider: 'gemini',
    capability: 'structured-generation',
    env: 'RV_GEMINI_TEXT_MODEL',
    fallback: 'gemini-3-flash',
  }),

  'provider.gemini.imageModel': roleModelSetting({
    key: 'provider.gemini.imageModel',
    label: { fa: 'مدل تصویری جِمینای', en: 'Gemini image model' },
    help: {
      fa: 'مدل تصویرساز گوگل. هیچ مدل تصویری گوگل سطح رایگان ندارد؛ هر فراخوانی هزینه دارد.',
      en: "Google's image model. No Google image model has a free tier - every call costs money.",
    },
    provider: 'gemini',
    capability: 'image-generation',
    env: 'RV_GEMINI_IMAGE_MODEL',
    fallback: 'gemini-3.1-flash-lite-image',
  }),

  'provider.gemini.visionModel': roleModelSetting({
    key: 'provider.gemini.visionModel',
    label: { fa: 'مدل بینایی جِمینای', en: 'Gemini vision model' },
    help: {
      fa: 'مدل جِمینای برای امتیازدهی بصری در دروازهٔ کیفیت.',
      en: 'The Gemini model used to score images at the quality gate.',
    },
    provider: 'gemini',
    capability: 'vision-scoring',
    env: 'RV_GEMINI_VISION_MODEL',
    fallback: 'gemini-3-flash',
  }),

  'provider.openrouter.apiKey': {
    key: 'provider.openrouter.apiKey',
    group: 'providers',
    label: { fa: 'کلید اوپن‌روتر', en: 'OpenRouter API key' },
    help: {
      fa: 'یک کلید برای دسترسی به همهٔ مدل‌های اوپن‌روتر، از جمله استخر رایگان.',
      en: 'One key for every OpenRouter model, including the free pool.',
    },
    scope: 'machine',
    secret: true,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'secret' },
    env: { name: 'OPENROUTER_API_KEY', format: 'string' },
    schema: z.string().max(500),
    default: '',
  } satisfies SettingDescriptor<string>,

  'provider.openrouter.siteUrl': {
    key: 'provider.openrouter.siteUrl',
    group: 'providers',
    label: { fa: 'نشانی سایت اوپن‌روتر', en: 'OpenRouter site URL' },
    help: {
      fa: 'اوپن‌روتر این نشانی را برای انتساب درخواست‌ها می‌خواهد؛ در رتبه‌بندی عمومی آن‌ها ظاهر می‌شود.',
      en: 'OpenRouter attributes requests to this URL; it appears in their public rankings.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'url', placeholder: 'http://localhost:5173' },
    env: { name: 'OPENROUTER_SITE_URL', format: 'string' },
    schema: z.url(),
    default: 'http://localhost:5173',
  } satisfies SettingDescriptor<string>,

  'provider.openrouter.appName': {
    key: 'provider.openrouter.appName',
    group: 'providers',
    label: { fa: 'نام برنامه در اوپن‌روتر', en: 'OpenRouter app name' },
    help: {
      fa: 'نامی که در گزارش مصرف اوپن‌روتر کنار درخواست‌های این نصب دیده می‌شود.',
      en: "The name shown beside this installation's requests in OpenRouter's usage report.",
    },
    scope: 'machine',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'text', placeholder: 'Rivayat' },
    env: { name: 'OPENROUTER_APP_NAME', format: 'string' },
    schema: NonEmptyString.max(80),
    default: 'Rivayat',
  } satisfies SettingDescriptor<string>,

  'provider.openrouter.textModel': roleModelSetting({
    key: 'provider.openrouter.textModel',
    label: { fa: 'مدل متنی اوپن‌روتر', en: 'OpenRouter text model' },
    help: {
      fa: 'مدل پیش‌فرض اوپن‌روتر برای کارهای متنی. مدل‌های با پسوند ‎:free‎ هزینه ندارند.',
      en: "OpenRouter's default text model. Models with the `:free` suffix cost nothing.",
    },
    provider: 'openrouter',
    capability: 'structured-generation',
    env: 'RV_OPENROUTER_TEXT_MODEL',
    fallback: 'z-ai/glm-5.2:free',
  }),

  'provider.openrouter.imageModel': roleModelSetting({
    key: 'provider.openrouter.imageModel',
    label: { fa: 'مدل تصویری اوپن‌روتر', en: 'OpenRouter image model' },
    help: {
      fa: 'مدل تصویرساز پیش‌فرض اوپن‌روتر. هیچ مدل ‎:free‎ تصویر تولید نمی‌کند.',
      en: "OpenRouter's default image model. No `:free` model produces images.",
    },
    provider: 'openrouter',
    capability: 'image-generation',
    env: 'RV_OPENROUTER_IMAGE_MODEL',
    fallback: 'openai/gpt-5-image-mini',
  }),

  'provider.openrouter.visionModel': roleModelSetting({
    key: 'provider.openrouter.visionModel',
    label: { fa: 'مدل بینایی اوپن‌روتر', en: 'OpenRouter vision model' },
    help: {
      fa: 'مدل اوپن‌روتر برای امتیازدهی بصری. گزینه‌های رایگان بینا موجودند.',
      en: 'The OpenRouter model used for vision scoring. Free vision options exist.',
    },
    provider: 'openrouter',
    capability: 'vision-scoring',
    env: 'RV_OPENROUTER_VISION_MODEL',
    fallback: 'google/gemma-4-31b-it:free',
  }),

  'provider.huggingface.token': {
    key: 'provider.huggingface.token',
    group: 'providers',
    label: { fa: 'توکن هاگینگ‌فیس', en: 'Hugging Face token' },
    help: {
      fa: 'فقط برای دانلود وزن مدل‌های محلی (مثل مدل جداسازی پس‌زمینه) لازم است. مخازن عمومی به آن نیاز ندارند.',
      en: 'Only needed to download local model weights, such as the matting model. Public repositories do not require it.',
    },
    scope: 'machine',
    secret: true,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'secret' },
    env: { name: 'HF_TOKEN', format: 'string' },
    schema: z.string().max(500),
    default: '',
  } satisfies SettingDescriptor<string>,

  'provider.huggingface.cacheDir': {
    key: 'provider.huggingface.cacheDir',
    group: 'providers',
    label: { fa: 'پوشهٔ کش هاگینگ‌فیس', en: 'Hugging Face cache directory' },
    help: {
      fa: 'محل نگهداری وزن‌های دانلودشده. آن را بیرون از درخت مخزن نگه دارید؛ حجمش به گیگابایت می‌رسد.',
      en: 'Where downloaded weights live. Keep it out of the repository tree; it runs to gigabytes.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: true,
    dependsOn: [],
    control: { kind: 'text', placeholder: './workspace/cache/huggingface' },
    env: { name: 'HF_HOME', format: 'string' },
    schema: NonEmptyString.max(500),
    default: './workspace/cache/huggingface',
  } satisfies SettingDescriptor<string>,

  // ── models: per-stage selection, tier, routing policy ──────────────────────

  'model.stage.intake': stageModelSetting('intake'),
  'model.stage.style': stageModelSetting('style'),
  'model.stage.story': stageModelSetting('story'),
  'model.stage.cast': stageModelSetting('cast'),
  'model.stage.world': stageModelSetting('world'),
  'model.stage.resolve': stageModelSetting('resolve'),
  'model.stage.produce': stageModelSetting('produce'),
  'model.stage.sequence': stageModelSetting('sequence'),
  'model.stage.choreograph': stageModelSetting('choreograph'),
  'model.stage.preview': stageModelSetting('preview'),
  'model.stage.render': stageModelSetting('render'),
  'model.stage.deliver': stageModelSetting('deliver'),

  'model.qualityTier': {
    key: 'model.qualityTier',
    group: 'models',
    label: { fa: 'سطح کیفیت', en: 'Quality tier' },
    help: {
      fa: 'چقدر خوب بودن خروجی این بار اهمیت دارد. «پیش‌نویس» لِین محلی و رایگان است؛ «نهایی» لِین ابری و پولی.',
      en: 'How good the output has to be this time. Draft is the free local lane; final is the paid cloud lane.',
    },
    scope: 'run',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'select' },
    options: enumOptions(QualityTier.options, {
      draft: { fa: 'پیش‌نویس', en: 'Draft' },
      preview: { fa: 'پیش‌نمایش', en: 'Preview' },
      final: { fa: 'نهایی', en: 'Final' },
    }),
    schema: QualityTier,
    default: 'draft',
  } satisfies SettingDescriptor<QualityTier>,

  'model.routingPolicy': {
    key: 'model.routingPolicy',
    group: 'models',
    label: { fa: 'سیاست مسیریابی', en: 'Routing policy' },
    help: {
      fa: 'وقتی چند مدل سطح کیفیت را برآورده می‌کنند، تساوی چگونه شکسته شود.',
      en: 'How to break a tie between candidate models that all satisfy the tier.',
    },
    scope: 'run',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'select' },
    options: enumOptions(RoutingPolicy.options, {
      cheapest: { fa: 'ارزان‌ترین', en: 'Cheapest' },
      balanced: { fa: 'متعادل', en: 'Balanced' },
      best: { fa: 'بهترین', en: 'Best' },
    }),
    schema: RoutingPolicy,
    default: 'balanced',
  } satisfies SettingDescriptor<RoutingPolicy>,

  'model.pinStageOverrides': {
    key: 'model.pinStageOverrides',
    group: 'models',
    label: { fa: 'قفل کردن انتخاب مدل مرحله', en: 'Pin stage model choices' },
    help: {
      fa: 'روشن: اگر مدل انتخاب‌شده در دسترس نباشد، مرحله شکست می‌خورد. خاموش: زنجیرهٔ جایگزین مسیریاب وارد می‌شود. برای انتخاب هنری روشن و برای صرفه‌جویی خاموش بگذارید.',
      en: 'On: the stage fails rather than silently running on a model you did not choose. Off: the failover chain takes over. On for a creative preference, off for a cost preference.',
    },
    scope: 'run',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'toggle' },
    schema: z.boolean(),
    default: true,
  } satisfies SettingDescriptor<boolean>,

  // ── image lane ─────────────────────────────────────────────────────────────

  'image.lane': {
    key: 'image.lane',
    group: 'image',
    label: { fa: 'لِین تولید تصویر', en: 'Image lane' },
    help: {
      fa: 'تصاویر کجا ساخته شوند. سامانه با هر کدام از این سه به‌تنهایی کامل کار می‌کند؛ کولب هرگز الزامی نیست.',
      en: 'Where images are generated. The system runs complete on any one of these alone - Colab is never a requirement.',
    },
    scope: 'project',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'select' },
    options: enumOptions(ImageLane.options, {
      'local-comfyui': { fa: 'کامفی‌یوآی محلی', en: 'Local ComfyUI' },
      colab: { fa: 'کامفی‌یوآی روی کولب', en: 'ComfyUI on Colab' },
      'cloud-api': { fa: 'سرویس ابری', en: 'Cloud API' },
    }),
    schema: ImageLane,
    default: 'local-comfyui',
  } satisfies SettingDescriptor<ImageLane>,

  'image.comfyui.enabled': {
    key: 'image.comfyui.enabled',
    group: 'image',
    label: { fa: 'کامفی‌یوآی فعال است', en: 'ComfyUI enabled' },
    help: {
      fa: 'خاموش کنید تا سامانه بدون تلاش برای اتصال به کامفی‌یوآی کار کند - مثلاً روی ماشینی که کارت گرافیک ندارد.',
      en: 'Turn off to run without attempting to reach ComfyUI at all - on a machine with no GPU, for instance.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: false,
    dependsOn: [{ key: 'image.lane', equals: ['local-comfyui', 'colab'] }],
    control: { kind: 'toggle' },
    env: { name: 'RV_COMFYUI_ENABLED', format: 'boolean' },
    schema: z.boolean(),
    default: true,
  } satisfies SettingDescriptor<boolean>,

  'image.comfyui.host': {
    key: 'image.comfyui.host',
    group: 'image',
    label: { fa: 'آدرس کامفی‌یوآی', en: 'ComfyUI host' },
    help: {
      fa: 'نشانی محلی یا نشانی تونل کولب. تنها تفاوت دو لِین همین مقدار است؛ آداپتور با هر دو یک API را حرف می‌زند.',
      en: 'A loopback address or a Colab tunnel URL. The two lanes differ only in this value; the adapter speaks the same HTTP API to both.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: false,
    dependsOn: [{ key: 'image.lane', equals: ['local-comfyui', 'colab'] }],
    control: { kind: 'url', placeholder: 'http://127.0.0.1:8288' },
    env: { name: 'COMFYUI_HOST', format: 'string' },
    schema: z.url(),
    // 8188 falls inside a Windows reserved TCP range (8163-8262, WinNAT) on the
    // owner's machine, so the default port is deliberately not ComfyUI's own.
    default: 'http://127.0.0.1:8288',
  } satisfies SettingDescriptor<string>,

  'image.comfyui.remote': {
    key: 'image.comfyui.remote',
    group: 'image',
    label: { fa: 'کامفی‌یوآی از راه دور است', en: 'ComfyUI is remote' },
    help: {
      fa: 'روشن یعنی آدرس بالا یک تونل عمومی است. در این حالت توکن اجباری می‌شود، چون کامفی‌یوآی احراز هویت ندارد و تونل بدون توکن یک تصویرساز باز روی اینترنت است.',
      en: 'On means the host above is a public tunnel. The token then becomes mandatory: ComfyUI has no authentication of its own, and an untokened tunnel is an open image generator on the public internet.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: false,
    dependsOn: [{ key: 'image.lane', equals: ['local-comfyui', 'colab'] }],
    control: { kind: 'toggle' },
    env: { name: 'RV_COMFYUI_REMOTE', format: 'boolean' },
    schema: z.boolean(),
    default: false,
  } satisfies SettingDescriptor<boolean>,

  'image.comfyui.authToken': {
    key: 'image.comfyui.authToken',
    group: 'image',
    label: { fa: 'توکن کامفی‌یوآی', en: 'ComfyUI auth token' },
    help: {
      fa: 'رمز مشترک دروازهٔ توکن جلوی کامفی‌یوآی راه دور. آداپتور آن را در هدر Authorization می‌فرستد. در حالت محلی نادیده گرفته می‌شود.',
      en: 'The shared secret for the token gate in front of a remote ComfyUI. The adapter sends it as an Authorization header. Ignored on the local lane.',
    },
    scope: 'machine',
    secret: true,
    requiresRestart: false,
    dependsOn: [
      { key: 'image.lane', equals: ['local-comfyui', 'colab'] },
      { key: 'image.comfyui.remote', equals: [true] },
    ],
    control: { kind: 'secret' },
    env: { name: 'COMFYUI_AUTH_TOKEN', format: 'string' },
    schema: z.string().max(500),
    default: '',
  } satisfies SettingDescriptor<string>,

  'image.comfyui.workflowDir': {
    key: 'image.comfyui.workflowDir',
    group: 'image',
    label: { fa: 'پوشهٔ گردش‌کارهای کامفی‌یوآی', en: 'ComfyUI workflow directory' },
    help: {
      fa: 'محل گردش‌کارهای JSON که آداپتور به کامفی‌یوآی می‌فرستد.',
      en: 'Where the JSON workflows the adapter submits to ComfyUI live.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: false,
    dependsOn: [{ key: 'image.lane', equals: ['local-comfyui', 'colab'] }],
    control: { kind: 'text', placeholder: './tools/comfy-workflows' },
    env: { name: 'RV_COMFYUI_WORKFLOW_DIR', format: 'string' },
    schema: NonEmptyString.max(500),
    default: './tools/comfy-workflows',
  } satisfies SettingDescriptor<string>,

  // ── budget ─────────────────────────────────────────────────────────────────

  'budget.perRunNanoUsd': {
    key: 'budget.perRunNanoUsd',
    group: 'budget',
    label: { fa: 'سقف هزینهٔ هر اجرا', en: 'Per-run ceiling' },
    help: {
      fa: 'یک حلقهٔ خراب پرامپت را متوقف می‌کند. خالی یعنی بدون سقف در این سطح.',
      en: 'Stops one bad prompt loop. Empty means no ceiling at this scope.',
    },
    scope: 'run',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'money', minNanoUsd: 0, stepNanoUsd: CENT_NANO_USD, nullable: true },
    env: { name: 'RV_BUDGET_USD_PER_RUN', format: 'usd-dollars' },
    schema: NanoUsdAmount.nullable(),
    default: 5_000_000_000,
  } satisfies SettingDescriptor<number | null>,

  'budget.perDayNanoUsd': {
    key: 'budget.perDayNanoUsd',
    group: 'budget',
    label: { fa: 'سقف هزینهٔ روزانه', en: 'Per-day ceiling' },
    help: {
      fa: 'یک زمان‌بند از کنترل خارج‌شده را متوقف می‌کند. خالی یعنی بدون سقف روزانه.',
      en: 'Stops a runaway scheduler. Empty means no daily ceiling.',
    },
    scope: 'global',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'money', minNanoUsd: 0, stepNanoUsd: CENT_NANO_USD, nullable: true },
    env: { name: 'RV_BUDGET_USD_PER_DAY', format: 'usd-dollars' },
    schema: NanoUsdAmount.nullable(),
    default: 25_000_000_000,
  } satisfies SettingDescriptor<number | null>,

  'budget.perProjectNanoUsd': {
    key: 'budget.perProjectNanoUsd',
    group: 'budget',
    label: { fa: 'سقف هزینهٔ پروژه', en: 'Per-project ceiling' },
    help: {
      fa: 'عددی که پرداخت‌کننده واقعاً با آن موافقت کرده است. خالی یعنی بدون سقف.',
      en: 'The number the person paying actually agreed to. Empty means no ceiling.',
    },
    scope: 'project',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'money', minNanoUsd: 0, stepNanoUsd: CENT_NANO_USD, nullable: true },
    schema: NanoUsdAmount.nullable(),
    default: null,
  } satisfies SettingDescriptor<number | null>,

  'budget.confirmAboveNanoUsd': {
    key: 'budget.confirmAboveNanoUsd',
    group: 'budget',
    label: { fa: 'تأیید برای هزینهٔ بیش از', en: 'Confirm above' },
    help: {
      fa: 'سقف نیست؛ نقطه‌ای است که اجرا می‌ایستد و می‌پرسد. مسئلهٔ اصلی «زیاد خرج شد» نیست، «بدون پرسیدن خرج شد» است.',
      en: 'Not a ceiling - the point at which the run stops and asks. The failure we care about is not "spent too much", it is "spent anything at all without being asked".',
    },
    scope: 'run',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'money', minNanoUsd: 0, stepNanoUsd: CENT_NANO_USD, nullable: true },
    env: { name: 'RV_CONFIRM_SPEND_ABOVE_USD', format: 'usd-dollars' },
    schema: NanoUsdAmount.nullable(),
    default: 1_000_000_000,
  } satisfies SettingDescriptor<number | null>,

  'budget.onExceed': {
    key: 'budget.onExceed',
    group: 'budget',
    label: { fa: 'هنگام عبور از سقف', en: 'When a ceiling is crossed' },
    help: {
      fa: 'رفتار نگهبان بودجه وقتی فراخوانی بعدی از سقف عبور می‌کند.',
      en: 'What the budget guard does when the next call would cross a ceiling.',
    },
    scope: 'run',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'select' },
    options: enumOptions(BudgetAction.options, {
      abort: { fa: 'توقف اجرا', en: 'Abort the run' },
      pause: { fa: 'مکث و پرسش', en: 'Pause and ask' },
      downgrade: { fa: 'کاهش سطح کیفیت', en: 'Downgrade the tier' },
    }),
    schema: BudgetAction,
    default: 'abort',
  } satisfies SettingDescriptor<BudgetAction>,

  // ── render ─────────────────────────────────────────────────────────────────

  'render.backend': {
    key: 'render.backend',
    group: 'render',
    label: { fa: 'موتور رندر', en: 'Render backend' },
    help: {
      fa: 'کدام موتور فریم‌ها را می‌کشد. «خودکار» بر اساس امکاناتی که ترکیب واقعاً استفاده می‌کند تصمیم می‌گیرد.',
      en: "Which renderer draws the frames. `auto` decides from the composition's own feature use.",
    },
    scope: 'project',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'select' },
    options: enumOptions(RenderBackend.options, {
      'pixi-playwright': { fa: 'پیکسی در پلی‌رایت (جلوه و شیدر)', en: 'PixiJS in Playwright' },
      'napi-canvas': { fa: 'بوم آفسکرین (دوبعدی خالص)', en: 'Offscreen canvas' },
      auto: { fa: 'خودکار', en: 'Automatic' },
    }),
    env: { name: 'RV_RENDER_BACKEND', format: 'string' },
    schema: RenderBackend,
    default: 'auto',
  } satisfies SettingDescriptor<RenderBackend>,

  'render.concurrency': {
    key: 'render.concurrency',
    group: 'render',
    label: { fa: 'هم‌زمانی رندر', en: 'Render concurrency' },
    help: {
      fa: 'چند شارد رندر هم‌زمان اجرا شوند. بالاتر از تعداد هسته‌های آزاد، رندر را کندتر می‌کند نه سریع‌تر.',
      en: 'How many render shards run at once. Above the number of free cores this makes rendering slower, not faster.',
    },
    scope: 'project',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'slider', min: 1, max: 16, step: 1 },
    env: { name: 'RV_RENDER_CONCURRENCY', format: 'integer' },
    schema: z.number().int().min(1).max(16),
    default: 2,
  } satisfies SettingDescriptor<number>,

  'render.ffmpegPath': {
    key: 'render.ffmpegPath',
    group: 'render',
    label: { fa: 'مسیر ffmpeg', en: 'ffmpeg path' },
    help: {
      fa: 'اگر ffmpeg در PATH نیست، مسیر کامل اجرایی را بدهید.',
      en: 'The full path to the executable, when ffmpeg is not on PATH.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'text', placeholder: 'ffmpeg' },
    env: { name: 'RV_FFMPEG_PATH', format: 'string' },
    schema: NonEmptyString.max(500),
    default: 'ffmpeg',
  } satisfies SettingDescriptor<string>,

  'render.ffprobePath': {
    key: 'render.ffprobePath',
    group: 'render',
    label: { fa: 'مسیر ffprobe', en: 'ffprobe path' },
    help: {
      fa: 'اگر ffprobe در PATH نیست، مسیر کامل اجرایی را بدهید.',
      en: 'The full path to the executable, when ffprobe is not on PATH.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'text', placeholder: 'ffprobe' },
    env: { name: 'RV_FFPROBE_PATH', format: 'string' },
    schema: NonEmptyString.max(500),
    default: 'ffprobe',
  } satisfies SettingDescriptor<string>,

  // ── delivery ───────────────────────────────────────────────────────────────

  'delivery.formats': {
    key: 'delivery.formats',
    group: 'delivery',
    label: { fa: 'قالب‌های تحویل', en: 'Delivery formats' },
    help: {
      fa: 'این پروژه به کدام قالب‌ها تحویل داده می‌شود. افزودن یک قالب هزینهٔ تولید ندارد: قاب‌بندی مجدد محاسبه می‌شود، نه بازتولید.',
      en: 'Which targets this project ships to. Adding one costs nothing to generate: re-framing is computed, not re-authored.',
    },
    scope: 'project',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'multi-select', minSelected: 1 },
    options: formatOptions(),
    schema: z.array(FormatProfileId).min(1),
    default: ['yt-1080p', 'shorts-9x16', 'reels-9x16', 'tiktok-9x16'],
  } satisfies SettingDescriptor<FormatProfileId[]>,

  // ── interface ──────────────────────────────────────────────────────────────

  'interface.locale': {
    key: 'interface.locale',
    group: 'interface',
    label: { fa: 'زبان رابط', en: 'Interface locale' },
    help: {
      fa: 'زبان متن‌های رابط کاربری. فارسی پیش‌فرض است.',
      en: 'The language of the interface. Persian is the default.',
    },
    scope: 'global',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'select' },
    options: enumOptions(Locale.options, {
      fa: { fa: 'فارسی', en: 'Persian' },
      en: { fa: 'انگلیسی', en: 'English' },
    }),
    schema: Locale,
    default: 'fa',
  } satisfies SettingDescriptor<Locale>,

  'interface.direction': {
    key: 'interface.direction',
    group: 'interface',
    label: { fa: 'جهت نوشتار', en: 'Text direction' },
    help: {
      fa: '«خودکار» جهت را از زبان می‌گیرد. آن را فقط وقتی دستی کنید که می‌خواهید چیدمان با زبان هم‌خوان نباشد.',
      en: 'Automatic derives the direction from the locale. Override it only when you want the layout to disagree with the language.',
    },
    scope: 'global',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'select' },
    options: enumOptions(TextDirection.options, {
      auto: { fa: 'خودکار (از زبان)', en: 'Automatic (from locale)' },
      rtl: { fa: 'راست به چپ', en: 'Right to left' },
      ltr: { fa: 'چپ به راست', en: 'Left to right' },
    }),
    schema: TextDirection,
    default: 'auto',
  } satisfies SettingDescriptor<TextDirection>,

  // ── runtime ────────────────────────────────────────────────────────────────

  'runtime.logLevel': {
    key: 'runtime.logLevel',
    group: 'runtime',
    label: { fa: 'سطح گزارش', en: 'Log level' },
    help: {
      fa: 'کم‌ترین سطحی که ثبت می‌شود. «ردیابی» هر فراخوانی ارائه‌دهنده را ثبت می‌کند و بسیار پرحجم است.',
      en: 'The lowest level that gets recorded. Trace logs every provider call and is very noisy.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'select' },
    options: enumOptions(LOG_LEVELS, {
      trace: { fa: 'ردیابی', en: 'Trace' },
      debug: { fa: 'اشکال‌زدایی', en: 'Debug' },
      info: { fa: 'اطلاعات', en: 'Info' },
      warn: { fa: 'هشدار', en: 'Warn' },
      error: { fa: 'خطا', en: 'Error' },
    }),
    env: { name: 'RV_LOG_LEVEL', format: 'string' },
    schema: z.enum(LOG_LEVELS),
    default: 'debug',
  } satisfies SettingDescriptor<(typeof LOG_LEVELS)[number]>,

  'runtime.workspaceDir': {
    key: 'runtime.workspaceDir',
    group: 'runtime',
    label: { fa: 'پوشهٔ فضای کار', en: 'Workspace directory' },
    help: {
      fa: 'دادهٔ زمان اجرا بیرون از درخت مخزن زندگی می‌کند. این ریشهٔ آن است.',
      en: 'Runtime data lives outside the repository tree. This is its root.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: true,
    dependsOn: [],
    control: { kind: 'text', placeholder: './workspace' },
    env: { name: 'RV_WORKSPACE_DIR', format: 'string' },
    schema: NonEmptyString.max(500),
    default: './workspace',
  } satisfies SettingDescriptor<string>,

  'runtime.assetStoreDir': {
    key: 'runtime.assetStoreDir',
    group: 'runtime',
    label: { fa: 'پوشهٔ انبار دارایی', en: 'Asset store directory' },
    help: {
      fa: 'انبار محتوا-محور بایت‌ها. بین همهٔ پروژه‌های این ماشین مشترک است؛ جابه‌جایی آن یعنی جابه‌جایی همهٔ دارایی‌ها.',
      en: 'The content-addressed store. It is shared by every project on the machine - moving it moves every asset.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: true,
    dependsOn: [],
    control: { kind: 'text', placeholder: './workspace/assets' },
    env: { name: 'RV_ASSET_STORE_DIR', format: 'string' },
    schema: NonEmptyString.max(500),
    default: './workspace/assets',
  } satisfies SettingDescriptor<string>,

  'runtime.databaseUrl': {
    key: 'runtime.databaseUrl',
    group: 'runtime',
    label: { fa: 'نشانی پایگاه داده', en: 'Database URL' },
    help: {
      fa: 'یک نشانی ‎file:‎ یا ‎:memory:‎. طرح نشانی همان کلید انتخاب پیاده‌سازی است.',
      en: "A `file:` URL or `:memory:`. The URL's scheme is the switch that picks the implementation.",
    },
    scope: 'machine',
    secret: false,
    requiresRestart: true,
    dependsOn: [],
    control: { kind: 'text', placeholder: 'file:./workspace/rivayat.db' },
    env: { name: 'RV_DB_URL', format: 'string' },
    schema: NonEmptyString.max(500),
    default: 'file:./workspace/rivayat.db',
  } satisfies SettingDescriptor<string>,

  'runtime.apiPort': {
    key: 'runtime.apiPort',
    group: 'runtime',
    label: { fa: 'پورت API', en: 'API port' },
    help: {
      fa: 'پورتی که سرویس API روی آن گوش می‌دهد.',
      en: 'The port the API server listens on.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: true,
    dependsOn: [],
    control: { kind: 'number', min: 1, max: 65_535, step: 1 },
    env: { name: 'RV_API_PORT', format: 'integer' },
    schema: z.number().int().min(1).max(65_535),
    default: 3000,
  } satisfies SettingDescriptor<number>,

  'runtime.apiPrefix': {
    key: 'runtime.apiPrefix',
    group: 'runtime',
    label: { fa: 'پیشوند مسیر API', en: 'API path prefix' },
    help: {
      fa: 'پیشوندی که جلوی همهٔ مسیرهای API می‌آید.',
      en: 'Prefixed to every API route.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: true,
    dependsOn: [],
    control: { kind: 'text', placeholder: 'api' },
    env: { name: 'RV_API_PREFIX', format: 'string' },
    schema: NonEmptyString.max(60),
    default: 'api',
  } satisfies SettingDescriptor<string>,

  'runtime.webOrigin': {
    key: 'runtime.webOrigin',
    group: 'runtime',
    label: { fa: 'مبدأ برنامهٔ وب', en: 'Web origin' },
    help: {
      fa: 'تنها مبدأیی که CORS اجازهٔ عبورش را می‌دهد. اشتباه بودن آن یعنی رابط کاربری به API نمی‌رسد.',
      en: 'The only origin CORS lets through. Getting it wrong means the UI cannot reach the API.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: true,
    dependsOn: [],
    control: { kind: 'url', placeholder: 'http://localhost:5173' },
    env: { name: 'RV_WEB_ORIGIN', format: 'string' },
    schema: z.url(),
    default: 'http://localhost:5173',
  } satisfies SettingDescriptor<string>,

  'runtime.queueConcurrency': {
    key: 'runtime.queueConcurrency',
    group: 'runtime',
    label: { fa: 'هم‌زمانی صف', en: 'Queue concurrency' },
    help: {
      fa: 'چند کار خط لوله هم‌زمان اجرا شوند. مستقل از هم‌زمانی رندر است.',
      en: 'How many pipeline jobs run at once. Independent of render concurrency.',
    },
    scope: 'machine',
    secret: false,
    requiresRestart: true,
    dependsOn: [],
    control: { kind: 'slider', min: 1, max: 32, step: 1 },
    env: { name: 'RV_QUEUE_CONCURRENCY', format: 'integer' },
    schema: z.number().int().min(1).max(32),
    default: 4,
  } satisfies SettingDescriptor<number>,

  'runtime.redisUrl': {
    key: 'runtime.redisUrl',
    group: 'runtime',
    label: { fa: 'نشانی ردیس', en: 'Redis URL' },
    help: {
      fa: 'خالی بگذارید تا خط لوله درون‌فرایندی اجرا شود؛ برای توسعه به ردیس نیازی نیست. یک نشانی معمولاً حاوی رمز است، پس مثل راز با آن رفتار می‌شود.',
      en: 'Leave empty to run the pipeline in-process; development needs no Redis. A URL usually carries a password, so it is treated as a secret.',
    },
    scope: 'machine',
    secret: true,
    requiresRestart: true,
    dependsOn: [],
    control: { kind: 'secret', placeholder: 'redis://localhost:6379' },
    env: { name: 'REDIS_URL', format: 'string' },
    schema: z.string().max(500),
    default: '',
  } satisfies SettingDescriptor<string>,
} satisfies Record<string, AnySettingDescriptor> & {
  // A mapped type over `PipelineStageKey`, so a stage added to the pipeline is a
  // compile error here rather than a stage nobody can pick a model for.
  [S in PipelineStageKey as `model.stage.${S}`]: SettingDescriptor<ModelRef | null>;
};

// ── derived views ───────────────────────────────────────────────────────────

/** Every key in the registry, as a literal union. A typo is a compile error. */
export type SettingKey = keyof typeof SETTINGS;

/** The value type a given key holds. */
export type SettingValueOf<K extends keyof typeof SETTINGS> =
  (typeof SETTINGS)[K] extends SettingDescriptor<infer TValue> ? TValue : never;

/** Declaration order, which is also the order the settings screen renders. */
export const SETTINGS_REGISTRY: readonly AnySettingDescriptor[] = Object.values(SETTINGS);

/**
 * Every key, in declaration order.
 *
 * The assertion is `Object.keys`' fault, not ours: it is typed `string[]` for any
 * object, because a subtype could carry extra properties. `SETTINGS` is a closed literal,
 * so its own keys are exactly `SettingKey` - and `registry.spec.ts` re-derives this list
 * from the descriptors themselves and asserts the two agree.
 */
export const SETTING_KEYS: readonly SettingKey[] = Object.keys(SETTINGS) as SettingKey[];

/**
 * The descriptor for a key.
 *
 * Total, not partial: `SettingKey` is the key set of the registry object, so there is no
 * "not found" case to model. That is the whole reason the registry is a record.
 */
export function settingFor<K extends SettingKey>(key: K): (typeof SETTINGS)[K] {
  return SETTINGS[key];
}

/** True when `key` names a registry entry. The runtime half of `SettingKey`. */
export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

/** Everything in one panel, in declaration order. */
export function settingsInGroup(group: SettingGroup): readonly AnySettingDescriptor[] {
  return SETTINGS_REGISTRY.filter((descriptor) => descriptor.group === group);
}
