/**
 * `@rv/prompt-kit` - prompts in, validated data out.
 *
 * Nothing else in the codebase may ask a language model for JSON. See
 * `docs/00-research.md` §1 for the measured reason.
 */

export type {
  PromptRole,
  PromptMessage,
  ImagePayload,
  TokenUsage,
  CompletionRequest,
  CompletionResponse,
  StructuredBackend,
} from './backend';

export type { ExtractionStep, Extraction } from './json-extract';
export { extractJson, removeTrailingCommas } from './json-extract';

export type { RepairMessage } from './repair';
export { buildRepairMessage, buildSchemaInstruction, formatPath } from './repair';

export type {
  StructuredResolution,
  StructuredTrace,
  StructuredSuccess,
  StructuredFailure,
  StructuredRequest,
  StructuredCallDeps,
} from './structured-call';
export { StructuredCall } from './structured-call';

export type { TemplateValue, TemplateVars, RenderedPrompt } from './template';
export { PromptTemplate, composePrompt, section } from './template';
