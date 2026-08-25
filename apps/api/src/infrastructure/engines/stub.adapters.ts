/**
 * The bindings for ports whose engine package is still a scaffold.
 *
 * Six of the fourteen workspace packages export nothing but their own name today.
 * Rather than leave the modules out - which makes a 501 look like a 404 and a missing
 * feature look like a typo - every port is bound here to an adapter that refuses in
 * the taxonomy, naming the package that owes the work.
 *
 * What this buys, beyond honesty: the route exists, the request is validated, the
 * error mapping is exercised, the OpenAPI document lists the endpoint, and the e2e
 * suite asserts the 501. When the engine lands, `app.module.ts` swaps one `useValue`
 * and every one of those stays true.
 */

import type {
  AssetSpec,
  AssetVersion,
  Brief,
  ContinuityIssue,
  EpisodeId,
  MemoryRetrievalRequest,
  MemoryRetrievalResult,
  Scene,
  SeriesBible,
  SeriesId,
  Shot,
  Slug,
  StyleBible,
  StyleBibleId,
} from '@rv/contracts';
import type { Result } from '@rv/shared-kernel';

import { notImplementedAsync } from '../../application/not-implemented';
import type {
  AssetProductionPort,
  AssetProductionRequest,
  DeriveStyleRequest,
  NarrativeMemoryPort,
  ProbeStyleRequest,
  RenderOutput,
  RenderPort,
  RenderRequest,
  StoryEnginePort,
  StyleEnginePort,
} from '../../application/ports/engine.ports';
import type { StylePresetList, StyleProbeSheet } from '../../modules/style/style.contracts';

const STYLE_ENGINE = '@rv/style-engine';
const STORY_ENGINE = '@rv/story-engine';
const ASSET_ENGINE = '@rv/asset-engine';
const NARRATIVE_MEMORY = '@rv/narrative-memory';
const RENDER_ENGINE = '@rv/render-engine';

/**
 * Kept after S1 was wired for real, and not as a leftover.
 *
 * `app.module.ts` binds `StyleEngineAdapter` now, so nothing reaches this in a running
 * process. It stays because it is the only thing that can stand in for the engine in a
 * context that has no database, no blob store and no image lane - and because deleting
 * it would leave the *shape* of a refusal untested for the one port most likely to be
 * unwired again in a deployment that turns generation off.
 */
export class StubStyleEngine implements StyleEnginePort {
  listPresets(): Promise<Result<StylePresetList>> {
    return notImplementedAsync('style presets', STYLE_ENGINE);
  }
  fromPreset(_preset: Slug): Promise<Result<StyleBible>> {
    return notImplementedAsync('style from preset', STYLE_ENGINE);
  }
  find(_id: StyleBibleId): Promise<Result<StyleBible>> {
    return notImplementedAsync('style bible lookup', STYLE_ENGINE);
  }
  derive(_request: DeriveStyleRequest): Promise<Result<StyleBible>> {
    return notImplementedAsync('style derivation from references', STYLE_ENGINE);
  }
  probe(_request: ProbeStyleRequest): Promise<Result<StyleProbeSheet>> {
    return notImplementedAsync('style probe sheet', STYLE_ENGINE);
  }
  lock(_id: StyleBibleId): Promise<Result<StyleBible>> {
    return notImplementedAsync('style lock', STYLE_ENGINE);
  }
}

export class StubStoryEngine implements StoryEnginePort {
  generateSeriesBible(_brief: Brief, _style: StyleBible): Promise<Result<SeriesBible>> {
    return notImplementedAsync('S2 story bible generation', STORY_ENGINE);
  }
  generateWorld(_bible: SeriesBible, _episodeId: EpisodeId): Promise<Result<readonly AssetSpec[]>> {
    return notImplementedAsync('S4 world generation', STORY_ENGINE);
  }
  generateShotList(_scene: Scene, _style: StyleBible): Promise<Result<readonly Shot[]>> {
    return notImplementedAsync('S7 shot list generation', STORY_ENGINE);
  }
}

export class StubAssetProduction implements AssetProductionPort {
  produce(_request: AssetProductionRequest): Promise<Result<AssetVersion>> {
    return notImplementedAsync('S6 asset production', ASSET_ENGINE);
  }
}

export class StubNarrativeMemory implements NarrativeMemoryPort {
  ingestScene(_seriesId: SeriesId, _scene: Scene): Promise<Result<readonly ContinuityIssue[]>> {
    return notImplementedAsync('scene ingestion into the narrative graph', NARRATIVE_MEMORY);
  }
  retrieve(_request: MemoryRetrievalRequest): Promise<Result<MemoryRetrievalResult>> {
    return notImplementedAsync('budgeted memory retrieval', NARRATIVE_MEMORY);
  }
  checkContinuity(_episodeId: EpisodeId): Promise<Result<readonly ContinuityIssue[]>> {
    return notImplementedAsync('continuity check', NARRATIVE_MEMORY);
  }
}

export class StubRenderEngine implements RenderPort {
  render(_request: RenderRequest): Promise<Result<RenderOutput>> {
    return notImplementedAsync('S10 render', RENDER_ENGINE);
  }
}
