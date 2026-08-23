# ADR-0002: Procedural animation over generated assets, not generative video

**Status:** Accepted — 2026-08-23. This is the load-bearing economic decision of the project;
every other cost assumption depends on it.

## Context

The obvious 2026 way to build "idea → animated series" is the one
[ViMax](https://github.com/hkuds/vimax) and its family take: plan with agents, then hand each shot
to a text-to-video or image-to-video model (Veo / Sora / Seedance) and concatenate the clips. It
works, it looks good, and it is the shortest path to a demo.

It is also structurally wrong for a **multi-episode series**, for four reasons that compound:

1. **Cost is charged per second of output.** A 60-second short and its 12 revisions cost 13 × the
   full duration. Nothing is amortised.
2. **Output is not editable.** A generated clip is pixels. "Move the character 200px left", "hold
   that beat 300 ms longer", "she should be wearing the winter coat" are not edits — they are
   regenerations, at full price, with a new random outcome.
3. **Nothing is reusable across episodes.** Episode 2 re-pays for the same character in the same
   room. There is no asset library, because there are no assets — only frames.
4. **It is not deterministic.** Two runs of the same prompt differ. Identity drifts between shots
   and between episodes. Our non-negotiable #1 (bit-reproducible renders, replayable pipeline runs)
   is unreachable by construction.

Our differentiator is the series, not the clip. Episode N+1 must be nearly free, or the whole
proposition collapses.

## Decision

**Generate assets once; compute motion.**

The image models produce _parts_ — transparent, depth-ordered layers of a character, a prop, a
tree. Those parts are content-addressed, rigged, and stored in a shared library. Motion is then
**computed** by `@rv/anim-engine` from a rig and an `AnimationIR` (ADR-0001), and rendered
deterministically (ADR-0003).

The consequence is the whole point: **cost scales with the number of unique assets, not with
frames, seconds, revisions, aspect ratios, or episodes.**

### The arithmetic

Verified image pricing from [`00-research.md` §2](../00-research.md) (live from the OpenRouter
`/api/v1/models` catalogue, 2026-08-23): `google/gemini-3.1-flash-lite-image` at **$30 per 1M
image-output tokens ≈ $0.0336 per 1024px image**.

A 60-second short needs roughly **40–120 unique assets** — the cast with their expression and pose
sets, wardrobes, locations, props, foliage, sky and FX elements:

```
  40 assets × $0.0336  =  $1.34
 120 assets × $0.0336  =  $4.03
```

Add quality-gate retries and the occasional variant and the realistic band is **$1.50 – $5.00,
paid once.**

After that, the following cost **$0.00**:

| Operation                                               | Why it is free                                             |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| Re-render the same 60 seconds                           | Motion is computed from the IR; no model is called         |
| Re-time a shot, change an ease, extend a hold           | A number in the IR changes; frames are recomputed          |
| Re-frame to 9:16, 4:5, 1:1 for six delivery targets     | One composition, per-format reframing from `focusTarget`   |
| Export to Lottie, a sprite atlas, ProRes and H.264      | All are projections of the same IR                         |
| Episode 2, 3, …, N in the same style with the same cast | Registry hit on `semanticKey + styleChecksum + variantKey` |
| Fix a line of dialogue and re-render the scene          | Nothing generative is re-invoked                           |

Contrast with the per-second model, where every one of those rows is a fresh full-duration bill —
and returns a _different_ result each time.

> We deliberately quote **no** price for Veo / Sora / Seedance. Those figures were not live-checked
> for `00-research.md`, and the argument does not need them: the decisive difference is not the
> unit price but that the unit is _seconds of output, re-paid on every change_, versus _unique
> assets, paid once_. Any per-second price loses this comparison at series length.

## Consequences

**Positive.** A user can iterate on timing, staging, camera and dialogue without spending money,
which is what makes the studio UI (stage S9) a real editor rather than a preview. Cost is
predictable and can be quoted _before_ the run: stage S5 resolves every `AssetSpec` against the
registry and shows an exact estimate, because the demand set is a graph query (`02-domain-model.md`
§5), not an estimate. Determinism gives us golden-file tests, resumable renders and shardable
renders. Style changes fork the library cleanly via the `styleChecksum` in the dedup key instead of
silently mismatching.

**Negative.** We must build the parts of the pipeline the generative approach gets for free:
layer decomposition, auto-rigging, a motion-preset library per archetype, an evaluator and a
renderer. That is most of `asset-engine`, `anim-engine` and `render-engine`. The output ceiling is
also different in kind — this produces **rigged 2D cutout animation**, not photoreal or
freely-imagined camera moves. Motion quality is bounded by our rig templates and motion presets,
not by a model's imagination. Some shots (fluid simulation, crowd chaos, complex 3D camera) are
simply out of scope or must be faked with FX layers.

**Accepted risk.** If generative video becomes near-free and frame-accurate editable, the
economics of this ADR change. The mitigation is already in the architecture: generation sits
behind `ImageGenerationPort`, and a future `VideoGenerationPort` would be an additional adapter,
not a rewrite. The IR would still own the timeline.

## Alternatives considered

**Full generative video per shot (the ViMax path).** Rejected on all four counts above. Its own
documentation notes generated clips are "usually only a few seconds long", which means a 60-second
piece is a concatenation of independently-drifting fragments — the exact failure mode a series
cannot tolerate.

**Hybrid: generative video for establishing shots, procedural for character work.** Attractive,
and not permanently closed off. Rejected _for now_ because it reintroduces the two things we are
buying with this decision — non-determinism and non-editability — into a subset of shots, which
means the render pipeline needs two code paths, the cost estimator needs two models, and "re-render
for free" stops being universally true. Revisit once the procedural path is complete and the
delta is measurable rather than assumed.

**Frame-by-frame image generation (generate 1800 images for 60 s at 30 fps).** Rejected on
arithmetic alone: 1800 × $0.0336 = **$60.48 per 60 seconds, per render**, with no temporal
coherence and no editability. It is strictly worse than both other options.

**Traditional keyframe animation authored by a human in an existing tool.** Rejected: it is not
the product. The point is that the pipeline authors the animation; a human edits it.
