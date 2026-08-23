/**
 * The subset of the Lottie document model this exporter writes.
 *
 * Typed rather than `unknown` because the field names are the whole contract with
 * `lottie-web` and they are two-letter abbreviations: `ks`, `ip`, `op`, `sr`, `bm`. A
 * typo in one of those produces a file that parses, loads, and renders nothing, and no
 * amount of testing the *values* catches it. The names are documented once, here.
 *
 * Targets the schema `lottie-web` 5.13 reads (research §5). Fields Bodymovin emits that
 * carry no information for us - `ix` property indices, `hd` hidden flags, `cix`, `np` -
 * are deliberately absent: they are editor bookkeeping and every runtime treats them as
 * optional.
 */

/** A cubic-bezier tangent handle. Arrays because Lottie allows one entry per dimension. */
export interface LottieEase {
  readonly x: readonly number[];
  readonly y: readonly number[];
}

/**
 * One keyframe of an animated property.
 *
 * `s` is the value **at** `t`, and the segment it starts runs to the next keyframe's
 * `s`. `o` is the out-tangent of this keyframe and `i` the in-tangent of the next -
 * both stored on the keyframe that *begins* the segment, which is exactly where our
 * `Keyframe.easing` lives ("easing applied on the way out of this keyframe").
 */
export interface LottieKeyframe {
  readonly t: number;
  readonly s: readonly number[];
  readonly i?: LottieEase;
  readonly o?: LottieEase;
  /** 1 holds `s` for the whole segment - a stepped key. */
  readonly h?: 1;
}

export interface LottieStaticProperty {
  readonly a: 0;
  readonly k: number | readonly number[];
}

export interface LottieAnimatedProperty {
  readonly a: 1;
  readonly k: readonly LottieKeyframe[];
}

export type LottieProperty = LottieStaticProperty | LottieAnimatedProperty;

/**
 * A layer transform.
 *
 * `a` anchor (px), `p` position (px), `s` scale (percent), `r` rotation (degrees,
 * clockwise, y-down - the same convention the IR uses), `o` opacity (0..100),
 * `sk`/`sa` skew angle and skew axis.
 */
export interface LottieTransform {
  readonly a: LottieProperty;
  readonly p: LottieProperty;
  readonly s: LottieProperty;
  readonly r: LottieProperty;
  readonly o: LottieProperty;
  readonly sk?: LottieProperty;
  readonly sa?: LottieProperty;
}

/** Layer type codes. Only the four we emit. */
export const LOTTIE_LAYER = {
  image: 2,
  null: 3,
  shape: 4,
  text: 5,
} as const;

export interface LottieShapeItem {
  readonly ty: string;
  readonly [field: string]: unknown;
}

export interface LottieTextDocumentKeyframe {
  readonly t: number;
  readonly s: {
    readonly f: string;
    readonly fc: readonly number[];
    readonly j: number;
    readonly lh: number;
    readonly ls: number;
    readonly s: number;
    readonly t: string;
    readonly tr: number;
  };
}

export interface LottieTextData {
  readonly d: { readonly k: readonly LottieTextDocumentKeyframe[] };
  readonly a: readonly unknown[];
  readonly p: Record<string, never>;
  readonly m: { readonly g: number; readonly a: LottieProperty };
}

export interface LottieLayer {
  readonly ddd: 0;
  /** 1-based index. Unique within the composition. */
  readonly ind: number;
  readonly ty: number;
  readonly nm: string;
  /** Match name. Carries the IR node id, which is how a consumer joins back to source. */
  readonly mn: string;
  /** Time stretch. Always 1: re-timing belongs to the IR, not to the projection. */
  readonly sr: 1;
  readonly ks: LottieTransform;
  /** Auto-orient. Always 0 - `orientToPath` is a behaviour and is baked, not delegated. */
  readonly ao: 0;
  readonly ip: number;
  readonly op: number;
  readonly st: number;
  /** Blend mode. 0 = normal; the IR has no blend modes. */
  readonly bm: 0;
  readonly refId?: string;
  readonly w?: number;
  readonly h?: number;
  readonly shapes?: readonly LottieShapeItem[];
  readonly t?: LottieTextData;
}

export interface LottieImageAsset {
  readonly id: string;
  readonly w: number;
  readonly h: number;
  readonly u: string;
  readonly p: string;
  /** 0 = `p` is a file name, 1 = `p` is an inline data URI. */
  readonly e: 0 | 1;
}

export interface LottieFont {
  readonly fName: string;
  readonly fFamily: string;
  readonly fStyle: string;
  readonly fWeight: string;
  readonly ascent: number;
}

export interface LottieMarker {
  readonly tm: number;
  readonly cm: string;
  readonly dr: number;
}

/**
 * The document.
 *
 * `v` schema version, `fr` frame rate, `ip`/`op` in and out point **in frames**, `w`/`h`
 * the composition size. Those six plus `layers` are what a player checks before it will
 * touch the file.
 */
export interface LottieDocument {
  readonly v: string;
  readonly fr: number;
  readonly ip: number;
  readonly op: number;
  readonly w: number;
  readonly h: number;
  readonly nm: string;
  readonly ddd: 0;
  readonly assets: readonly LottieImageAsset[];
  readonly layers: readonly LottieLayer[];
  readonly markers: readonly LottieMarker[];
  readonly fonts?: { readonly list: readonly LottieFont[] };
}
