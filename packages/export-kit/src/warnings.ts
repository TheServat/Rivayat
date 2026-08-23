/**
 * The loss report.
 *
 * An export that quietly drops something is worse than one that fails: the file opens,
 * it plays, and the thing that is missing is only noticed by whoever is looking at the
 * wrong frame three weeks later. So every projection returns the list of what it could
 * not carry, named against the same closed feature vocabulary the exporters declare
 * their capabilities in.
 *
 * Three dispositions, because "lossy" hides a distinction that matters when you are
 * deciding whether to ship the file.
 */

import { AppError, type ErrorKind } from '@rv/shared-kernel';

import { describeFeature, type FeatureUse, type IrFeature } from './features';

/**
 * How much of a feature survived.
 *
 * - `restructured` - every number survives, but not as the same structure. A flattened
 *   layer tree draws identically and cannot be re-parented.
 * - `approximated` - the numbers changed. A sampled behaviour is right at the sample
 *   points and interpolated in between.
 * - `dropped` - nothing survives. The format has no place to put it.
 */
export type WarningDisposition = 'restructured' | 'approximated' | 'dropped';

export interface ExportWarning {
  readonly feature: IrFeature;
  readonly disposition: WarningDisposition;
  /** What happened to it, in a sentence a reviewer can act on. */
  readonly detail: string;
  /** The node / track / behaviour ids that carry the feature. Possibly empty. */
  readonly ids: readonly string[];
}

/** How an exporter says "I carry this, but not exactly". */
export interface ApproximationNote {
  readonly disposition: Exclude<WarningDisposition, 'dropped'>;
  readonly detail: string;
}

/**
 * A format's ceiling, declared rather than discovered.
 *
 * Declared statically so a caller can ask "what would I lose?" **before** spending the
 * export, which is what makes the format list usable in a UI. What actually happened is
 * still reported per-export, because some losses depend on the options.
 */
export interface FormatCapabilities {
  /** Features that survive exactly. */
  readonly exact: ReadonlySet<IrFeature>;
  /** Features that survive, but changed. */
  readonly approximate: ReadonlyMap<IrFeature, ApproximationNote>;
}

/**
 * The features present in a document that the format cannot carry exactly.
 *
 * Anything neither exact nor declared-approximate is `dropped`: an exporter that
 * forgets to classify a feature reports it as lost, which fails loudly in the right
 * direction.
 */
export function diffFeatures(
  present: FeatureUse,
  capabilities: FormatCapabilities,
): readonly ExportWarning[] {
  const warnings: ExportWarning[] = [];

  for (const [feature, ids] of present) {
    if (capabilities.exact.has(feature)) continue;

    const note = capabilities.approximate.get(feature);
    warnings.push(
      note === undefined
        ? {
            feature,
            disposition: 'dropped',
            detail: `${describeFeature(feature)} has no representation in this format and was not written`,
            ids,
          }
        : { feature, disposition: note.disposition, detail: note.detail, ids },
    );
  }

  // Stable order, so two exports of the same document produce the same report and a
  // diff of two reports is a diff of the losses rather than of the iteration order.
  return warnings.sort((left, right) => left.feature.localeCompare(right.feature));
}

/** Warnings that mean the file no longer matches the IR numerically. */
export function lossyWarnings(warnings: readonly ExportWarning[]): readonly ExportWarning[] {
  return warnings.filter((warning) => warning.disposition !== 'restructured');
}

/**
 * The failure a `strict` export produces.
 *
 * `strict` exists because an automated pipeline cannot read a warning list. It turns
 * "you lost these seven things" from a field on a success into a failure that names
 * them, so a job that must not ship an approximation stops instead of shipping one.
 *
 * Its own class rather than `UnsupportedCapabilityError` because the interesting part
 * is the *list* - a caller wants to branch on which features were lost, and a joined
 * string in a message is not something code can branch on.
 */
export class UnsupportedFeaturesError extends AppError {
  readonly code = 'EXPORT_UNSUPPORTED_FEATURES';
  readonly kind: ErrorKind = 'unsupported';
  readonly retryable = false;
  readonly format: string;
  readonly lost: readonly ExportWarning[];

  constructor(format: string, lost: readonly ExportWarning[]) {
    super({
      message: `${format} cannot represent ${String(lost.length)} feature(s) of this IR: ${lost
        .map((warning) => warning.feature)
        .join(', ')}`,
      context: {
        format,
        lost: lost.map((warning) => ({
          feature: warning.feature,
          disposition: warning.disposition,
          ids: warning.ids,
        })),
      },
    });
    this.format = format;
    this.lost = lost;
  }
}
