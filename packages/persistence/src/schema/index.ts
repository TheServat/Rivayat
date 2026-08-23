/**
 * Every table in one place, because Drizzle's typed client and `drizzle-kit` both want
 * a single schema object and the migration generator diffs exactly what is exported
 * from here.
 */

export { embeddingVector, jsonDoc } from './columns';

export { blobs } from './blobs';
export type { BlobRow, NewBlobRow } from './blobs';

export { assets, assetVersions, clips, parts, spriteSheets, variants } from './assets';
export type {
  AssetRow,
  AssetVersionRow,
  ClipRow,
  NewAssetRow,
  NewAssetVersionRow,
  NewClipRow,
  NewPartRow,
  NewSpriteSheetRow,
  NewVariantRow,
  PartRow,
  SpriteSheetRow,
  VariantRow,
} from './assets';

export { styleBibles } from './style';
export type { NewStyleBibleRow, StyleBibleRow } from './style';

export { entities, facts, relations } from './narrative';
export type {
  EntityRow,
  FactRow,
  NewEntityRow,
  NewFactRow,
  NewRelationRow,
  RelationRow,
} from './narrative';

export { episodes, scenes, shots } from './story';
export type {
  EpisodeRow,
  NewEpisodeRow,
  NewSceneRow,
  NewShotRow,
  SceneRow,
  ShotRow,
} from './story';

export { settings } from './settings';
export type { NewSettingRow, SettingRow, SettingValueEnvelope } from './settings';

export { jobs, runs, usageRecords } from './ops';
export type {
  JobRow,
  NewJobRow,
  NewRunRow,
  NewUsageRecordRow,
  RunRow,
  UsageRecordRow,
} from './ops';
