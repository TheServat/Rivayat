# ADR-0008 — Motion providers, representations, and where determinism lives

**Status:** accepted
**Date:** 2026-08-24
**Context doc:** [docs/universal_ai_animation_system.md](../universal_ai_animation_system.md)

## Context

The owner supplied a design document for a universal animation system: art, structure,
motion, camera and rendering held apart so the same asset can be reused across many
animation styles; an asset carrying several _representations_ (2D, cutout, 2.5D,
isometric, 3D); motion supplied by interchangeable providers; and the governing rule that
**a new technology should arrive as a provider, not as a new architecture.**

A lot of it we already built, arriving from a different direction. Before deciding what to
change it is worth being exact about which is which, because the temptation with a
document this good is to adopt all of it and end up rewriting things that already work.

### Already true

| The document asks for                   | Where it already lives                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A scene graph of typed objects (§7)     | `AnimationIR` — flat nodes with `parentId`, seven node kinds                                                                     |
| Parallax from depth (§23)               | The `parallax` behaviour, reading each node's `depth` against the camera track                                                   |
| Procedural animation (§42)              | Thirteen behaviours: wind, breathe, blink, sway, walk-cycle, flap, orbit, parallax, boil, spring, look-at, follow-path, lip-sync |
| Keyframes with real interpolation (§19) | Tracks with a shared bezier solver, one implementation for renderer, sheet baker and exporter                                    |
| Data-driven animation (§32)             | `.rvanim.json` is the only motion artefact; the evaluator is a pure function of it                                               |
| Style independent of engine (§4)        | `StyleBible`, eleven presets, checksum-locked                                                                                    |
| Generate once, reuse forever (§52)      | The registry's dedup key; a second take needs an explicit intent                                                                 |
| Cache every expensive operation (§53)   | Content-addressed store, `compositeHash`                                                                                         |
| Provider abstraction (§50)              | Ports for image generation, matting, vision, structured LLM calls                                                                |
| Never store only the video (§61)        | The project _is_ the source; renders are outputs                                                                                 |
| Multiple output formats (§60)           | Seven platform deliverables from one composition                                                                                 |

So the disagreement is narrower than the document's scope suggests. Three things it asks
for are genuinely missing, and one of its groupings is wrong for us.

## Decision

### 1. Motion becomes a provider, and the IR is the determinism boundary

The document lists nine motion sources (§17) and does not say where determinism lives. For
us that question is not optional — bit-reproducible renders and replayable runs are the
first non-negotiable — so it has to be answered before any provider is written.

**The answer: providers _author_ motion; the IR _is_ the authored motion; evaluation is
pure.** A `MotionProvider` takes a request and returns tracks and behaviours, which are
written into the IR and content-hashed like everything else. Whether the provider was
deterministic is then irrelevant — a mocap import, a physics bake and an LLM proposing
keyframes all produce the same kind of artefact, and the artefact is what replays.

This is what makes the document's core principle safe to adopt. A new motion technology
becomes a provider precisely because providers sit _outside_ the determinism boundary and
the IR sits on it.

The corollary is a rule with teeth: **a provider may not be consulted at evaluation time.**
`evaluate(ir, t)` calls nothing. A provider that cannot bake is not a motion provider.

### 2. AI video is not a motion provider — it is a representation

The document groups AI video under Motion (§17, §21). For us that grouping does not
survive contact with the evaluator.

Motion is a function of time you can sample at any `t`. Footage is not — it is frames
somebody else already decided. Modelling video as motion means either the evaluator learns
to decode video (it does not; it is pure) or "motion" quietly means two incompatible
things, which is how a `switch` on kind ends up in core.

So AI video enters as an **asset representation** the compositor draws, sitting on the
timeline as a clip with an in-point and a duration. The document's actual intent (§21) is
preserved exactly — two seconds of engine animation, one second of AI video, four more of
engine — and it costs us no new concept in the motion system at all.

### 3. Representation becomes first-class, and cutout stops being assumed

Today every asset is implicitly a cutout rig. `AssetRepresentation` names what an asset
actually is — `flat`, `cutout`, `layered-2.5d`, `video`, and later `isometric` and `mesh`
— and an asset may carry several, because the same character can be a single image in a
wide shot and a rig in a close-up.

The payoff that justifies it now rather than later is 2.5D (§13, §24): depth estimation and
layer separation turn a flat generated image into a parallaxing scene. The `parallax`
behaviour that consumes this **already exists and has nothing to consume**, which is the
clearest possible signal that the gap is real. This is the cheapest cinematic quality in
the entire pipeline — no extra generation, one depth pass, and a flat drawing gains a
camera it can move through.

### 4. Projection is a camera mode, not an engine

Isometric is a projection, not a separate animation system (§14). The camera gains a
projection, and `isometric` is one value of it. Depth sorting follows from projection
rather than being a different renderer.

This is deliberately small. It is a matrix and a sort order, and refusing to treat it as a
matrix is how projects end up with an "isometric mode" that duplicates everything.

### 5. Clips leave their asset and become a library, with retargeting

`AnimationClip` currently belongs to the asset it was authored on. For a **multi-episode
series** that is the wrong shape: a walk cycle authored on one biped should apply to every
compatible biped, and authoring it forty times is the production cost this whole project
exists to avoid.

Clips move into a library addressed by rig compatibility, and retargeting (§41) maps a clip
from one skeleton to another. Anchors (§33) come with it — named points on an asset that
retargeting aligns to and that props attach to, which is also what lets a character hold a
sword without hard-coding a bone name.

Retargeting is pure arithmetic over two rigs, so it belongs in `anim-engine` at the 100 %
coverage tier, and it is testable the way the rest of that package is: a clip retargeted
onto a rig with identical proportions must evaluate identically at every sampled time.

## What we are not doing, and why

**Full 3D (§15, Phase 10).** Nothing in the product needs it. The output is short-form
video in four aspect ratios, and 2.5D plus a projection reaches that quality at a fraction
of the cost. `mesh` stays reserved in the representation union so adding it later is a
registration rather than a redesign, and the union stays exhaustive via `assertNever`.

**A physics engine (§43).** Deferred, not rejected. The behaviours already cover the
secondary motion that matters here — `spring`, `sway`, `wind`, `boil` — and they are pure,
seeded and free. A real engine earns its place when something needs collision or
constraint solving, and when it does it arrives as a motion provider that _bakes_, under
rule 1. Determinism is the acceptance criterion, not an afterthought: whatever is chosen
must produce identical output for identical input across platforms, and must be proved to
before it is wired in.

**Godot or Blender as the runtime (§46, §47, §48).** The document suggests them and they
are good tools, but we already render deterministically from the IR and export to Lottie,
DragonBones, sprite atlas and frame sequence. Adopting a game engine as the runtime would
trade a proven determinism story for a large dependency, and the argument for it — that
the engine provides animation, cameras and particles — describes capabilities we have. If a
Godot _export target_ is ever wanted it is another projection of the IR, which is the
existing pattern and does not touch the core.

**Motion capture (§17).** No source of data for it and no user asking. It is a provider
shape under rule 1 if it ever is.

## Consequences

- `evaluate(ir, t)` stays pure and stays the reference. Every new source of motion is
  something that writes an IR, never something the evaluator calls.
- A new animation technology is a registration in a map, not a change in core. No `switch`
  on provider or representation outside its registry.
- The representation union will grow. It must stay exhaustive, and an adapter that cannot
  serve a representation declares it so the router routes around rather than guessing.
- 2.5D adds a depth pass to asset production. It is a generation-time cost paid once per
  asset and cached like everything else — consistent with §52 rather than an exception to
  it.
- Clips moving to a library is a migration. Existing per-asset clips must keep resolving
  while the library fills, and the dedup key must not change under them.
