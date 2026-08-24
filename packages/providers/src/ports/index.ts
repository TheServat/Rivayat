/**
 * The narrow ports every adapter is measured against (architecture §5).
 *
 * `StructuredGenerationPort` is absent by design: `@rv/prompt-kit` already declares
 * `StructuredBackend` in the layer that uses it, and a second interface for the same
 * job would be one more thing to keep in step.
 */

export type { ImagePayload, ImageArtifact, ProviderUsage, ProviderCallResult } from './common';
export { toImageArtifact, usage, NO_TOKENS, NO_IMAGES } from './common';

export type { ProviderAdapter } from './provider-adapter';
export { declaresCapability } from './provider-adapter';

export type {
  TextGenerationRequest,
  TextGenerationResult,
  TextGenerationPort,
} from './text-generation';

export type {
  ImageCostQuote,
  ImageCostRequest,
  ImageGenerationRequest,
  ImageGenerationPort,
  ImageResult,
} from './image-generation';
export { projectedNanoUsd } from './image-generation';

export type { ImageEditRequest, ImageEditPort } from './image-edit';

export type { PartsSheetRequest, PartsSheetPort } from './parts-sheet';
export { supportsPartsSheet } from './parts-sheet';

export type {
  VisionRubricCriterion,
  VisionScoringRequest,
  VisionScore,
  VisionScoringResult,
  VisionScoringPort,
} from './vision-scoring';
export { VisionScoreSheet, buildRubricPrompt, parseScoreSheet } from './vision-scoring';

export type { EmbeddingRequest, EmbeddingResult, EmbeddingPort } from './embedding';

export type { PortByCapability, CapabilityMethod } from './capability-matrix';
export { CapabilityMatrix, CAPABILITY_METHOD } from './capability-matrix';
