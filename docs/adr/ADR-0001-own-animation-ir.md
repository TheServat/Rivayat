# ADR-0001: Author our own animation IR (`.rvanim.json`)

**Status:** Accepted — 2026-08-23. Supersedes nothing. Referenced by ADR-0002, ADR-0003.

## Context

Animation is produced by an LLM from a shot list, then edited by a human in our studio UI, then
rendered head-lessly and deterministically. The animation format sits between those three, so it
has to satisfy all of them at once:

| Requirement            | Why it is non-negotiable                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LLM-generatable**    | Stage S8 (Choreograph) emits it as structured JSON against a Zod schema. A format that requires a binary writer, a build step or an editor GUI cannot be emitted by a model.                                    |
| **Diffable**           | Every edit is reviewed and version-controlled. A 40 000-line per-frame property dump produces an unreadable diff for a one-second timing change.                                                                |
| **Deterministic**      | Non-negotiable #1 in `CLAUDE.md`: `evaluate(ir, t)` is a pure function of `t` and an explicit `seed`. Renders must be bit-reproducible.                                                                         |
| **Seek-safe**          | Distributed and resumable rendering, scrubbing in the preview player, and golden-file frame-hash tests all require that frame `N` can be computed without computing frames `0..N-1`.                            |
| **Editable in our UI** | The user edits at the semantic level — "make the wind stronger", "hold this pose 200 ms longer" — not at the baked-keyframe level. That requires the _behaviour_ to survive into the file, not just its output. |

No published format satisfies all five. Surveyed formats and runtimes are catalogued in
[`00-research.md` §5](../00-research.md).

## Decision

`AnimationIR`, serialised as `.rvanim.json`, is the **single source of truth** for animation. Its
shape is defined in [`01-architecture.md` §3.3](../01-architecture.md): `meta`, `nodes`, `tracks`,
`behaviours`, `markers`, `camera`. It is schema-defined in `@rv/contracts` and evaluated by
`@rv/anim-engine`.

Two properties do the work:

1. **`evaluate(ir, t) -> SceneSnapshot` is pure.** No accumulated state, no `Date.now()`, no
   `Math.random()`; procedural behaviours (`wind`, `breathe`, `boil`, `walkCycle`, `parallax`)
   take an explicit `seed` and are closed-form in `t`.
2. **Behaviours are declarative and parameterised, not baked.** A 6-second wind loop is ~8 lines
   of JSON, not 180 frames of rotation keys. That is what makes it both LLM-writable and
   human-editable, and what keeps diffs proportional to the size of the change.

Everything else is a **projection** of the IR, produced by `@rv/export-kit` or
`@rv/render-engine` and never edited in place:

`IR → PixiJS live playback` · `IR → PNG frames → FFmpeg` · `IR → baked sprite sheet + atlas.json`
· `IR → Lottie` · `IR → DragonBones`.

## Consequences

**Positive.** Scrubbing, resumable renders, shardable renders and `AnimationIR → frame hash`
golden tests all fall out of purity for free rather than being separately engineered. Diffs are
semantic. The LLM writes one JSON document instead of driving an editor. Multiple export targets
share one authoring path, so adding a fifth exporter costs an exporter, not a format.

**Negative.** We own an evaluator, a schema, a migration story for the schema, and an editor for
it — work that adopting Spine or Rive would have bought off the shelf. There is no third-party
tooling ecosystem: no external editor opens `.rvanim.json`, and no artist arrives already knowing
it. Round-tripping is one-way; a Lottie export edited elsewhere cannot be re-imported as source.
Because `anim-engine` is pure it is held to **100 % coverage** (`CLAUDE.md` §3) — deliberately
expensive, because a silent evaluator regression corrupts every render downstream.

**Mitigation for the ecosystem gap:** the exporters. Lottie and sprite-atlas output makes the work
playable in tooling we did not write, which covers the delivery cases; only authoring stays ours.

## Alternatives considered

**Spine (`.skel` / `.json`).** Best-in-class 2D skeletal runtime and the de facto standard.
Rejected: **proprietary and paid per-seat**, and the format's authority is the closed editor. We
cannot ship a pipeline whose source-of-truth format is owned by a vendor licence, and generating
Spine JSON without the editor means tracking an undocumented private schema.

**DragonBones.** Open source (Tencent) and structurally close to what we need. Rejected as source
of truth: the editor is **effectively unmaintained**, so the format is frozen at whatever the last
release understood, and it has no concept of parameterised procedural behaviours — everything is
baked keys. **Kept as an export target**, where a frozen, well-documented format is an advantage.

**Rive (`.riv`, `@rive-app/canvas` 2.40.1).** Excellent runtime, and its state machines are
genuinely ahead of what we are building. Rejected: `.riv` is a **binary format authored in a
closed cloud editor**. There is no supported way to _generate_ one programmatically, which
directly fails the LLM-generatable requirement and the diffable requirement in one stroke. **Kept
as a possible export target.**

**Lottie (`lottie-web` 5.13.0).** Open JSON, universally playable, and programmatically emittable
— the closest call. Rejected as source of truth because it is an **output format, not an
authoring format**: it stores baked per-property keyframe arrays with no rig semantics, no
behaviour parameters and no notion of "this is a wind behaviour at amplitude 0.3". Changing wind
strength means regenerating every affected keyframe, which destroys both diffability and
semantic UI editing. **Kept as the primary export target**, which is exactly what it is good at.

**Raw sprite sheets as source.** Rejected: re-timing, re-framing to another aspect ratio, or a
style change forces a full re-bake, and the frames carry no editable structure. Sprite sheets are
a **derived, cached artefact** in our design (`01-architecture.md` §6), rebuildable at any time.

**A generic scene-graph format (glTF, SVG+SMIL).** Rejected: glTF is 3D-first and its animation
model is baked sampler tracks; SVG/SMIL has no rigging, no deterministic seeded procedural layer,
and inconsistent renderer support. Both would need the same behaviour layer bolted on top, at
which point we own a format anyway — but one constrained by someone else's spec.
