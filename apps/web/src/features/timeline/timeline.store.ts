import type { AnimationId, AnimationIR } from '@rv/contracts';
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, type ComputedRef, type Ref, type ShallowRef } from 'vue';

import { useStudioApi } from '../../api/client';
import { ApiError, isApiError } from '../../api/errors';
import type { AnimationSummary } from '../../api/schemas/animations';

import { applyOp, type IrOp, type IrOpRefusal } from './ir-ops';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';

export interface TimelineSelection {
  readonly trackId: string;
  readonly index: number;
}

/** One reversible edit, as the undo stack remembers it. */
interface HistoryEntry {
  readonly before: AnimationIR;
  readonly after: AnimationIR;
  readonly op: IrOp;
  readonly inverse: IrOp;
  /**
   * The gesture this edit belongs to, when it belongs to one.
   *
   * A pointer drag emits an op per `pointermove` - eight of them for a short drag - and
   * without this the undo stack unwinds the gesture one pixel at a time. Undo has to
   * undo *the drag*, so consecutive ops carrying the same gesture collapse into the
   * entry already on the stack: its `before` and its `inverse` are kept, because those
   * are what return the document to where the gesture started.
   */
  readonly gesture: string | undefined;
}

function toApiError(caught: unknown, code: string, message: string): ApiError {
  return isApiError(caught)
    ? caught
    : new ApiError({ failure: 'network', code, message, cause: caught });
}

function missingEndpoint(error: ApiError): boolean {
  return error.failure === 'api' && error.status === 404;
}

export interface TimelineStore {
  readonly status: Ref<LoadStatus>;
  readonly error: Ref<ApiError | null>;
  readonly animations: Ref<readonly AnimationSummary[]>;
  readonly ir: ShallowRef<AnimationIR | null>;
  readonly timeMs: Ref<number>;
  readonly playing: Ref<boolean>;
  readonly looping: Ref<boolean>;
  readonly selection: Ref<TimelineSelection | null>;
  readonly selectedBehaviourId: Ref<string | null>;
  readonly refusal: Ref<IrOpRefusal | null>;
  readonly editCount: ComputedRef<number>;

  readonly frameMs: ComputedRef<number>;
  readonly frame: ComputedRef<number>;
  readonly frameCount: ComputedRef<number>;
  readonly durationMs: ComputedRef<number>;
  readonly canUndo: ComputedRef<boolean>;
  readonly canRedo: ComputedRef<boolean>;
  readonly lastOp: ComputedRef<IrOp | null>;

  load: () => Promise<void>;
  open: (animationId: AnimationId) => Promise<void>;
  seek: (timeMs: number) => void;
  seekFrame: (frame: number) => void;
  stepFrames: (delta: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlay: () => void;
  setLooping: (looping: boolean) => void;
  select: (selection: TimelineSelection | null) => void;
  selectBehaviour: (behaviourId: string | null) => void;
  apply: (op: IrOp, gesture?: string) => boolean;
  undo: () => void;
  redo: () => void;
  dismissRefusal: () => void;
}

/**
 * The timeline's state: one IR, one time, one undo stack.
 *
 * Two decisions here are load-bearing.
 *
 * **Time is the state, and the frame is a function of it.** Nothing in this store reads
 * a clock. Playback is the component's rAF loop calling `seek` with a time it derived
 * from the timestamp the browser handed it, so "scrub to t" and "play to t" set the
 * same state and therefore produce the same frame - not approximately, identically.
 * A store that accumulated per-frame deltas would drift, and the drift would be
 * invisible until somebody compared a preview to a render.
 *
 * **Undo keeps whole documents, not diffs.** An op returns a new IR and never mutates
 * the old one, so the previous document is already a value worth keeping, and restoring
 * it is exact by construction. RV-211's criterion is "undo restores the previous IR
 * byte for byte"; with a diff-based stack that is a property you hope for, and with
 * this one it is a property you cannot avoid.
 *
 * `shallowRef` for the IR: it is a large, deeply-frozen-in-practice document that is
 * replaced wholesale on every edit, and making every keyframe reactive would cost a
 * deep walk per drag frame for reactivity nothing reads.
 */
export const useTimelineStore = defineStore('timeline', (): TimelineStore => {
  const status = ref<LoadStatus>('idle');
  const error = ref<ApiError | null>(null);
  const animations = ref<readonly AnimationSummary[]>([]);
  const ir = shallowRef<AnimationIR | null>(null);
  const timeMs = ref(0);
  const playing = ref(false);
  const looping = ref(true);
  const selection = ref<TimelineSelection | null>(null);
  const selectedBehaviourId = ref<string | null>(null);
  const refusal = ref<IrOpRefusal | null>(null);

  const undoStack = shallowRef<readonly HistoryEntry[]>([]);
  const redoStack = shallowRef<readonly HistoryEntry[]>([]);

  /**
   * How many edits are *currently applied*, which is the undo stack's own depth.
   *
   * Not a counter that only goes up. The badge beside it says "not saved", and after an
   * undo that took the document back to where it started there is nothing unsaved - a
   * monotonic counter would keep claiming there was, which is the kind of small lie that
   * makes people stop reading a status line.
   */
  const editCount = computed(() => undoStack.value.length);

  const durationMs = computed(() => ir.value?.durationMs ?? 0);
  const frameMs = computed(() => 1000 / (ir.value?.fps ?? 24));
  const frame = computed(() => Math.round(timeMs.value / frameMs.value));
  const frameCount = computed(() => Math.max(1, Math.round(durationMs.value / frameMs.value)));
  const canUndo = computed(() => undoStack.value.length > 0);
  const canRedo = computed(() => redoStack.value.length > 0);
  const lastOp = computed(() => undoStack.value[undoStack.value.length - 1]?.op ?? null);

  async function load(): Promise<void> {
    status.value = 'loading';
    error.value = null;
    try {
      const index = await useStudioApi().listAnimations();
      animations.value = index.animations;
      const first = index.animations[0];
      if (first === undefined) {
        status.value = 'ready';
        return;
      }
      await open(first.id);
    } catch (caught) {
      const failure = toApiError(
        caught,
        'animations-load-failed',
        'the animation list could not be loaded',
      );
      error.value = failure;
      status.value = missingEndpoint(failure) ? 'unavailable' : 'error';
    }
  }

  async function open(animationId: AnimationId): Promise<void> {
    status.value = 'loading';
    error.value = null;
    try {
      const document = await useStudioApi().getAnimation(animationId);
      ir.value = document;
      timeMs.value = 0;
      playing.value = false;
      selection.value = null;
      selectedBehaviourId.value = document.behaviours[0]?.id ?? null;
      undoStack.value = [];
      redoStack.value = [];
      status.value = 'ready';
    } catch (caught) {
      const failure = toApiError(
        caught,
        'animation-open-failed',
        'the animation could not be opened',
      );
      error.value = failure;
      status.value = missingEndpoint(failure) ? 'unavailable' : 'error';
    }
  }

  /** Clamped to the clip, because a frame outside it is not a frame anybody renders. */
  function seek(next: number): void {
    if (!Number.isFinite(next)) return;
    const clamped = Math.min(Math.max(next, 0), durationMs.value);
    timeMs.value = clamped;
  }

  function seekFrame(nextFrame: number): void {
    seek(nextFrame * frameMs.value);
  }

  /**
   * One frame at a time, on the frame grid.
   *
   * Rounded to the grid first, so repeated steps from an arbitrary scrub position land
   * on frames rather than accumulating a fractional offset that never shows up as a
   * wrong number but does show up as a frame that stutters.
   */
  function stepFrames(delta: number): void {
    seekFrame(Math.round(timeMs.value / frameMs.value) + delta);
  }

  function setPlaying(next: boolean): void {
    playing.value = next;
  }

  function togglePlay(): void {
    playing.value = !playing.value;
  }

  function setLooping(next: boolean): void {
    looping.value = next;
  }

  function select(next: TimelineSelection | null): void {
    selection.value = next;
  }

  function selectBehaviour(behaviourId: string | null): void {
    selectedBehaviourId.value = behaviourId;
  }

  /**
   * Applies one typed op. Returns whether it was accepted.
   *
   * A refusal is state, not an exception: the screen shows why the keyframe would not
   * move, and the IR is untouched. Throwing here would take a drag gesture and turn it
   * into an unhandled rejection in a pointer handler.
   */
  function apply(op: IrOp, gesture?: string): boolean {
    const document = ir.value;
    if (document === null) return false;
    const result = applyOp(document, op);
    if (!result.ok) {
      refusal.value = result.refusal;
      return false;
    }
    refusal.value = null;

    const top = undoStack.value[undoStack.value.length - 1];
    // The entry this op continues, if any. Held as a value rather than as a boolean so
    // the two branches below read from something that is definitely there.
    const continued = gesture !== undefined && top?.gesture === gesture ? top : undefined;
    const entry: HistoryEntry =
      continued === undefined
        ? { before: document, after: result.ir, op, inverse: result.inverse, gesture }
        : { before: continued.before, after: result.ir, op, inverse: continued.inverse, gesture };

    undoStack.value =
      continued === undefined
        ? [...undoStack.value, entry]
        : [...undoStack.value.slice(0, -1), entry];
    redoStack.value = [];
    ir.value = result.ir;
    return true;
  }

  function undo(): void {
    const entry = undoStack.value[undoStack.value.length - 1];
    if (entry === undefined) return;
    undoStack.value = undoStack.value.slice(0, -1);
    redoStack.value = [...redoStack.value, entry];
    ir.value = entry.before;
    refusal.value = null;
  }

  function redo(): void {
    const entry = redoStack.value[redoStack.value.length - 1];
    if (entry === undefined) return;
    redoStack.value = redoStack.value.slice(0, -1);
    undoStack.value = [...undoStack.value, entry];
    ir.value = entry.after;
    refusal.value = null;
  }

  function dismissRefusal(): void {
    refusal.value = null;
  }

  return {
    status,
    error,
    animations,
    ir,
    timeMs,
    playing,
    looping,
    selection,
    selectedBehaviourId,
    refusal,
    editCount,
    frameMs,
    frame,
    frameCount,
    durationMs,
    canUndo,
    canRedo,
    lastOp,
    load,
    open,
    seek,
    seekFrame,
    stepFrames,
    setPlaying,
    togglePlay,
    setLooping,
    select,
    selectBehaviour,
    apply,
    undo,
    redo,
    dismissRefusal,
  };
});
