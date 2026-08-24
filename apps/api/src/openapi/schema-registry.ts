/**
 * Every schema the OpenAPI document describes, by name.
 *
 * This is the list that makes non-negotiable #5 checkable rather than aspirational:
 * each entry is the *same object* a controller validates with, so a document generated
 * from here cannot describe a shape the API does not enforce. There is no hand-written
 * DTO class anywhere in this app, and `openapi.spec.ts` asserts that the request schema
 * named by a route is the one its controller binds.
 */

import {
  Asset,
  AssetDemandPlan,
  AssetSpec,
  CostLedger,
  EpisodeOutline,
  FormatProfile,
  MemoryRetrievalRequest,
  Scene,
  StyleBible,
} from '@rv/contracts';
import type { z } from 'zod';

import { Project, RunSummary, SeriesCard } from '../application/resources';
import { CostReport } from '../cost/cost-report';
import {
  CompositionList,
  CompositionSummary,
  StoreCompositionBody,
  StoredComposition,
} from '../modules/compositions/compositions.contracts';
import { RunDelivery } from '../render/delivery.contracts';
import { ReframeBody, ReframePlanSet } from '../render/reframe.contracts';
import { ErrorEnvelope } from '../common/error-envelope';
import { ResolveAssetsBody, SearchAssetsBody } from '../modules/assets/assets.contracts';
import { HealthReport } from '../modules/health/health.contracts';
import { StartRunBody } from '../modules/pipeline/pipeline.contracts';
import { StartDeliveryBody } from '../modules/render/deliveries.contracts';
import { RenderBody } from '../modules/render/render.contracts';
import {
  CreateProjectRequest,
  ProjectList,
  UpdateProjectRequest,
} from '../modules/projects/projects.contracts';
import { CreateSeriesRequest } from '../modules/series/series.contracts';
import { SettingsPatch, SettingsSnapshot } from '../modules/settings/settings.contracts';
import { DeriveStyleBody, FromPresetBody } from '../modules/style/style.contracts';
import { RunEvent } from '../events/run-event';

export const API_SCHEMAS = {
  // envelopes
  ErrorEnvelope,
  HealthReport,

  // projects, series, episodes
  Project,
  CreateProjectRequest,
  UpdateProjectRequest,
  ProjectList,
  SeriesCard,
  CreateSeriesRequest,
  EpisodeOutline,

  // style
  StyleBible,
  FromPresetBody,
  DeriveStyleBody,

  // assets
  Asset,
  AssetSpec,
  AssetDemandPlan,
  ResolveAssetsBody,
  SearchAssetsBody,

  // narrative
  Scene,
  MemoryRetrievalRequest,

  // pipeline
  StartRunBody,
  RunSummary,
  RunEvent,
  CostLedger,
  CostReport,

  // render
  RenderBody,
  FormatProfile,
  ReframeBody,
  ReframePlanSet,
  RunDelivery,
  StartDeliveryBody,

  // compositions
  StoreCompositionBody,
  CompositionSummary,
  CompositionList,
  StoredComposition,

  // settings
  SettingsSnapshot,
  SettingsPatch,
} as const satisfies Record<string, z.ZodType>;

export type ApiSchemaName = keyof typeof API_SCHEMAS;
