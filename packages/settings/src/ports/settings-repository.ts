/**
 * The settings store, as a port.
 *
 * Declared here and implemented in `@rv/persistence`, which is the same seam every
 * other repository uses (ADR-0006): the application layer names what it needs and
 * infrastructure satisfies it, so a Postgres deployment is a DI binding rather than an
 * edit to anything above this line.
 *
 * Two invariants the types cannot express, and every implementation must honour:
 *
 * 1. **The machine layer is never stored.** It comes from `.env`, and writing it to the
 *    database would put a secret in a row that gets backed up, exported and diffed.
 *    `save` rejects a machine-scope layer rather than quietly persisting one.
 * 2. **A save is a merge, not a replace.** Storing a whole layer would mean a patch
 *    touching one field silently deletes every other override at that scope, because
 *    the form that produced it only ever sends what changed. Removing an override is
 *    {@link SettingsRepository.clear}, explicitly.
 */

import type { IsoInstant, SettingScope } from '@rv/contracts';
import type { Result, Unit } from '@rv/shared-kernel';

import type { SettingsLayer, SettingValues } from '../layers';

/** Which layer instance is being addressed. */
export interface SettingsScopeRef {
  readonly scope: SettingScope;
  /**
   * The project or run this layer belongs to.
   *
   * `null` for `global`, which has exactly one instance. Storage flattens `null` to the
   * empty string because SQLite does not treat two `NULL`s as equal in a primary key,
   * which would let a second "the" global layer be inserted alongside the first.
   */
  readonly scopeId: string | null;
}

/** Which layers to assemble into a stack. */
export interface SettingsStackRef {
  /** `null` to leave the project layer out entirely. */
  readonly projectId: string | null;
  /** `null` to leave the run layer out entirely. */
  readonly runId: string | null;
}

/** One stored override, with when it was last written. */
export interface StoredSetting {
  readonly scope: SettingScope;
  readonly scopeId: string | null;
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: IsoInstant;
}

export interface SettingsRepository {
  /** One layer, whole. Empty values when nothing has ever been written at that scope. */
  loadLayer(ref: SettingsScopeRef): Promise<Result<SettingsLayer>>;

  /**
   * The global, project and run layers in one read.
   *
   * The settings screen and every pipeline stage need all of them, and three round
   * trips per resolution is three round trips too many on a hot path.
   *
   * The machine layer is deliberately not included: it comes from `loadMachineLayer`,
   * and a caller that forgot it gets a stack with no `.env` in it rather than a stack
   * with `.env` silently persisted into the database.
   */
  loadStack(ref: SettingsStackRef): Promise<Result<readonly SettingsLayer[]>>;

  /** Merges `values` into the stored layer. Keys not present are left alone. */
  save(ref: SettingsScopeRef, values: SettingValues, now: IsoInstant): Promise<Result<Unit>>;

  /** Removes overrides, so the keys fall back to the layer below. */
  clear(ref: SettingsScopeRef, keys: readonly string[]): Promise<Result<Unit>>;

  /** Everything stored at one scope, for an export or an audit. */
  list(ref: SettingsScopeRef): Promise<Result<readonly StoredSetting[]>>;
}
