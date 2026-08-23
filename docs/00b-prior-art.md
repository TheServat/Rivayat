# 00b — Prior Art: what to copy, what to avoid

Surveyed 2026-08-23. The goal is not novelty for its own sake — where an existing project has
already solved a sub-problem well, we adopt its shape.

---

## A. End-to-end "idea → video" pipelines

### [HKUDS/ViMax](https://github.com/hkuds/vimax) — the closest full-pipeline reference

| What it does                                                                                                                | Verdict                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-agent roles: **Director / Screenwriter / Producer / Video Generator**                                                 | **Adopt.** Named roles with distinct system prompts and distinct model bindings beat one mega-prompt.                                                                                                                                                          |
| Three entry points: **Idea2Video**, **Script2Video**, **Novel2Video** (with "narrative compression and character tracking") | **Adopt.** Our `Intake` stage becomes polymorphic: `IdeaIntake`, `ScriptIntake`, `ProseIntake`, `SeriesBibleIntake`.                                                                                                                                           |
| Session persistence + `resume <session_id>`, artifact inspection in a web UI, render checkpoints                            | **Adopt.** Every stage checkpointed and resumable is non-negotiable for hour-long runs.                                                                                                                                                                        |
| Reference-image organisation for character/object/environment consistency + an explicit **consistency validation** pass     | **Adopt** — this is our `VisionScoringPort` quality gate.                                                                                                                                                                                                      |
| Parallelised shot/asset generation                                                                                          | **Adopt** (BullMQ concurrency with a per-provider rate limiter).                                                                                                                                                                                               |
| Provider abstraction via YAML (`configs/agent.local.yaml`) + `VIMAX_*` env vars                                             | **Adopt the idea, improve it**: ours is a typed capability matrix, not a YAML blob, so the router can _reason_ about what a provider can do.                                                                                                                   |
| Output is **generative video** (Veo / Seedance / Sora) — "usually only a few seconds long"                                  | **Reject.** This is the fundamental divergence. Generative video is expensive per second, non-editable, non-reusable, and drifts. We generate _assets once_ and animate them procedurally: editable, reusable, deterministic, and effectively free per second. |

### [ChrisChen667788/wind-comic](https://github.com/ChrisChen667788/wind-comic), [Anil-matcha/Open-AI-Micro-Drama-Generator](https://github.com/Anil-matcha/Open-AI-Micro-Drama-Generator), [SDSmirnov/AI-Story-To-Movie](https://github.com/SDSmirnov/AI-Story-To-Movie/)

Same family. The one idea worth lifting from `AI-Story-To-Movie` is **Auto-Casting**: automatically
identify the recurring characters and mint a canonical reference image per character _before_ any
scene is rendered. That is our `S3 Cast` stage, and it is why the asset registry is keyed on
character identity rather than on scene.

**Common weakness across all of them:** the "story" is a flat string passed between agents. None
has a queryable world model, so none can sustain a series. That is where we differentiate.

---

## B. Long-form narrative: planning, memory, character

From [Picrew/awesome-llm-story-generation](https://github.com/Picrew/awesome-llm-story-generation):

| Technique                                                                                          | Source                                  | How we use it                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detailed Outline Control** — expand an outline top-down, keep each expansion bound to its parent | `DOC`                                   | The `StoryBible` is a tree (Series → Season → Episode → Act → Sequence → Scene → Beat). Generation always expands exactly one level, never jumps.                                     |
| **Dynamic hierarchical outlining with memory enhancement**                                         | DOME, NAACL 2025                        | The outline is _re-planned_ as memory accumulates; later episodes can revise the plan for unwritten ones, never for aired ones.                                                       |
| **Recurrent memory state**                                                                         | `RecurrentGPT`                          | Each scene emits a short-term "state delta" that is folded into the world state, not just appended to a transcript.                                                                   |
| **CHIRON: rich character representations**                                                         | CHIRON                                  | Our `CharacterSheet` is psychology-first (want / need / wound / lie / flaw / voice), not just appearance. Visual descriptors are _derived_ from it.                                   |
| **Director–actor agent collaboration**                                                             | `IBSEN`, `HoLLMwood`, `Agents' Room`    | Scene dialogue is written by per-character "actor" calls constrained by that character's sheet, then reconciled by a "director" pass. This is how characters stop sounding identical. |
| **Story evaluation rubrics**                                                                       | `StoryER`, `ConStory-Bench`, `LitBench` | Basis for the automated critique pass before a draft is accepted.                                                                                                                     |

---

## C. Agent memory architectures — the single most valuable finding

Compared Mem0, Letta/MemOS, Cognee and **Zep/Graphiti**
([arXiv:2501.13956](https://arxiv.org/abs/2501.13956)).

**Graphiti's data model is almost exactly what a series bible needs:**

- `EpisodicNode` — the raw source utterance/document
- `EntityNode` — a resolved entity
- `EntityEdge` — a _fact_, carrying fact text + embedding
- `CommunityNode` — an auto-summarised cluster of entities
- **Bi-temporality on every edge**: `valid_at` / `invalid_at` (when the fact was true) _and_
  `created_at` / `expired_at` (when the system learned it)

**Why bi-temporality is the killer feature for fiction:** the two clocks are genuinely different.

- **Story time** — when it happened _in the fiction_ ("Aria's father died in year 1204").
- **Authoring time** — when _we decided_ it ("we invented that fact while writing Episode 7").

Retro-fitted backstory is normal in serialised fiction. A single-clock memory cannot represent
"a fact about Episode 2 that we only invented in Episode 7", so it either corrupts continuity or
forbids the edit. A bi-temporal graph handles it natively, and it also gives us free superpowers:

- "What did the audience know at the end of Episode 3?" → query at story-time T, authoring-time now.
- "What did **this character** know at that moment?" → same query, filtered by a `knows` edge.
- Contradiction detection → an assertion whose validity interval overlaps an incompatible fact.

Mem0's own paper found its graph variant ~3× slower and ~2× the token cost while _losing_ on
single- and multi-hop retrieval, so we do not copy the dual-store design. We implement a
Graphiti-shaped bi-temporal graph directly on SQLite (no extra service), with embeddings from
Ollama for the semantic half of hybrid retrieval.

**Adopted wholesale**: node/edge taxonomy, bi-temporal edges, community summarisation.
**Rejected**: running Zep/Neo4j as a service — this must stay local-first and zero-ops.

---

## D. 2D rigging / cutout animation

| Project                                                                      | Lesson                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [not-inept/bonehead](https://github.com/not-inept/bonehead)                  | Browser-based 2D skeletal editor with JSON project files and atlas export — confirms the whole thing is feasible in the browser, and that JSON-as-source-of-truth is the right call. Unmaintained, so a reference rather than a dependency. |
| [COA Tools](https://github.com/kreezii/coa_tools) (Blender cutout animation) | Its export shape — _PSD layers → individual files + a JSON of layer coordinates + spritesheet info_ — is precisely our `Parts + Rig + atlas.json` triple. Validates the data model.                                                         |
| DragonBones / Spine formats                                                  | Kept as **export targets** only (see ADR-0001).                                                                                                                                                                                             |

---

## E. Net effect on our design

Four concrete changes came out of this survey:

1. **Named agent roles** (Screenwriter, Director, Producer, Actor, Continuity Editor, Art Director)
   as first-class objects with their own prompt, model binding and critique rubric.
2. **Polymorphic intake**: idea / logline / script / prose / existing series bible.
3. **`@rv/narrative-memory`** — a bi-temporal narrative knowledge graph, Graphiti-shaped, on SQLite.
   This is what makes multi-episode series and the character graph work.
4. **Explicit rejection of generative video** as the output path, recorded in ADR-0002, with the
   cost and editability argument written down so it does not get relitigated.
