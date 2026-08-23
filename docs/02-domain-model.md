# 02 — Domain Model

Covers the three requirements that reshaped the model: **multi-episode series**, the
**character/entity graph**, and **narrative memory**.

---

## خلاصهٔ فارسی

- یک اثر می‌تواند **مجموعه (Series)** باشد: فصل‌ها و قسمت‌ها. سبک هنری و کتابخانهٔ asset‌ها در سطح
  Series مشترک‌اند، پس قسمت دوم به بعد تقریباً **رایگان** ساخته می‌شود.
- **گراف روایت**: شخصیت‌ها، مکان‌ها، اشیاء، گروه‌ها و مفاهیم گره‌اند؛ روابط یال. هر یال
  **دو-زمانه (bi-temporal)** است: هم «کِی در داستان درست بود» و هم «کِی ما این را نوشتیم».
- **حافظه**: هر چیزی که در قسمت‌های پخش‌شده اتفاق افتاده «canon» می‌شود و دیگر قابل نقض نیست.
  موتور continuity قبل از نهایی شدن هر قسمت، تناقض‌ها را پیدا می‌کند.
- مهم‌ترین قابلیت: **«چه کسی چه چیزی را می‌داند»** — دانش هر شخصیت جدا از حقیقت جهان ذخیره می‌شود،
  که راز، سوءتفاهم، و غافلگیری را ممکن می‌کند.

---

## 1. Work hierarchy

```
Series ─┬─ SeriesBible        (premise, themes, tone, rules-of-the-world, canon)
        ├─ StyleBible         (locked art + motion direction — shared by every episode)
        ├─ AssetLibrary ref   (shared; this is why episode N+1 is nearly free)
        ├─ NarrativeGraph     (the world model — see §3)
        └─ Season[] ─ Episode[] ─ Act[] ─ Sequence[] ─ Scene[] ─ Shot[] ─ Beat[]
```

A standalone short is simply a `Series` with one `Season` holding one `Episode`. There is no
second code path — the single-episode case is the degenerate case of the general one.

### `Episode` lifecycle

```
draft ──► outlined ──► scripted ──► boarded ──► asset-resolved
                                                     │
                                                     ▼
                                   choreographed ──► rendered ──► AIRED (canon frozen)
```

**`AIRED` is the important state.** Facts asserted by an aired episode become immutable canon.
Later episodes may _add_ to them and may _reveal_ previously hidden truths, but may not
contradict them — the continuity checker (§4) enforces this. Unaired episodes stay fully mutable,
which is what lets the planner re-outline the future as the story develops.

---

## 2. Entities

Every node in the world model is an `Entity` with a shared envelope and a typed payload.

```ts
type EntityKind =
  | 'character' | 'location' | 'prop' | 'faction' | 'creature'
  | 'concept'   | 'event'    | 'vehicle' | 'substance';

Entity {
  id, seriesId, kind, canonicalName, aliases[]
  summary                       // one paragraph, regenerated on change
  firstAppearance: StoryTime
  importance: 'lead'|'supporting'|'recurring'|'background'|'mentioned'
  assetRefs: AssetRef[]         // link into the asset library
  embedding: number[]           // for semantic retrieval
  payload: CharacterPayload | LocationPayload | ...
}
```

### `CharacterPayload` — CHIRON-shaped, psychology first

Appearance is _derived_ from psychology, not the other way round. This is what makes a character
readable in silhouette and consistent in behaviour.

```ts
CharacterPayload {
  identity:  { age, gender, species, occupation, origin }
  psych: {
    want, need, wound, lie, ghost,        // the classic dramatic engine
    virtues[], flaws[], fears[], values[]
    temperament: { warmth, dominance, volatility, openness, conscientiousness }
  }
  voice: {
    register, verbosity, idiolect[], verbalTics[], profanity,
    sentenceRhythm, humourMode, silenceHabits
  }                                        // ← the "actor" agent is bound by this
  arc: { startState, endState, turningPoints: BeatRef[] }
  visual: {                                // derived from psych + StyleBible
    silhouetteNote, build, height, palette[], distinguishingMarks[],
    wardrobe: WardrobeSet[],               // per-era / per-episode outfits
    expressionSet[], poseSet[], propAffinities[]
  }
  motionSignature: {                       // how THIS character moves
    gaitStyle, posture, gestureFrequency, energy, idleBehaviour, tellOnLying
  }
  knowledgeScope: 'omniscient'|'limited'   // drives the who-knows-what graph
}
```

`voice` and `motionSignature` exist because the two things that break a generated character are
(a) everyone sounding the same and (b) everyone moving the same. Both are now data, and both feed
directly into generation: `voice` into the actor agent, `motionSignature` into the rig's clip
parameters.

---

## 3. The narrative graph — bi-temporal

### Why two clocks

| Clock                                             | Question it answers                                          |
| ------------------------------------------------- | ------------------------------------------------------------ |
| **Story time** (`validFrom` / `validUntil`)       | When was this true _inside the fiction_?                     |
| **Authoring time** (`assertedAt` / `retractedAt`) | When did _we_ decide it, and is that decision still current? |

Serialised fiction constantly retro-fits backstory: in Episode 7 we decide that in Episode 2 the
mentor was already lying. A single-clock store cannot represent that without either corrupting
Episode 2 or forbidding the edit. Two clocks handle it natively.

```ts
Relation {
  id, seriesId
  from: EntityId, to: EntityId
  type: RelationType
  fact: string                  // human-readable, embedded for hybrid retrieval
  strength: -1..1               // signed: -1 hatred … +1 devotion
  // story time
  validFrom: StoryTime, validUntil: StoryTime | null
  // authoring time
  assertedAt: Instant, retractedAt: Instant | null
  // provenance
  sourceRef: { episodeId, sceneId? } | 'author' | 'inferred'
  confidence: number
  visibility: 'public' | 'private' | 'secret'   // what the audience knows
}
```

### Relation taxonomy

| Group         | Types                                                                |
| ------------- | -------------------------------------------------------------------- |
| Kinship       | `parent-of`, `sibling-of`, `spouse-of`, `descendant-of`              |
| Affinity      | `loves`, `trusts`, `resents`, `fears`, `envies`, `owes`              |
| Social        | `ally-of`, `rival-of`, `enemy-of`, `mentor-of`, `serves`, `commands` |
| Spatial       | `located-in`, `travels-to`, `native-to`                              |
| Possession    | `owns`, `carries`, `lost`, `seeks`, `created`                        |
| **Epistemic** | `knows`, `believes-falsely`, `suspects`, `witnessed`, `told`         |
| Narrative     | `foreshadows`, `pays-off`, `parallels`, `symbolises`                 |

### The epistemic layer is the point

Storing **what is true** and **what each character believes** as _separate_ edges is what makes
dramatic irony mechanically possible:

- `truth`: `(Aria) —parent-of→ (Kael)`, `visibility: secret`, valid from year 0
- `belief`: `(Kael) —believes-falsely→ "my parents died in the fire"`, valid E01–E08
- `reveal`: at E08 the belief edge gets `validUntil = E08`, and
  `(Kael) —knows→ (Aria is my mother)` opens

The scene writer for E05 is then handed **Kael's** view of the world, not the narrator's — so Kael
cannot accidentally act on information he does not have. This one mechanism removes the most
common failure mode of LLM-written serials.

### Derived views

- `CommunityNode` — auto-clustered groups (a household, a faction, a subplot) with a rolling
  LLM summary; keeps retrieval cheap on a large graph.
- `Timeline` — all relations ordered by story time; renders as the series chronology.
- `RelationshipMatrix` — `strength` between leads over time; drives the UI's character graph view
  and flags arcs that never actually change.

---

## 4. Narrative memory

### Layers

| Layer           | Content                                                                 | Written by               | Read by                  |
| --------------- | ----------------------------------------------------------------------- | ------------------------ | ------------------------ |
| **Canon**       | Immutable facts from aired episodes                                     | `AirEpisode`             | everything               |
| **World state** | Snapshot at any `StoryTime`: who is alive/where/holding what/knows what | folded from scene deltas | scene writer, continuity |
| **Episodic**    | Per-scene raw text + its extracted `StateDelta`                         | scene writer             | summariser, retrieval    |
| **Semantic**    | Entities, relations, embeddings                                         | extractor                | retrieval                |
| **Compaction**  | scene → episode → season → series rolling summaries                     | summariser               | long-range planning      |
| **Open loops**  | Foreshadowing planted but unpaid, promises to the audience              | planner + extractor      | planner, continuity      |

### Retrieval: hybrid, bounded, deterministic

Assembling context for "write scene 14 of episode 6" is a **budgeted** operation, not a dump:

```
score(fact) = w1·graphProximity(fact, sceneEntities)     // k-hop from entities in this scene
            + w2·semanticSimilarity(fact, sceneGoal)     // embedding
            + w3·storyRecency(fact)                      // recent story-time beats matter more
            + w4·importance(entity)                      // leads outrank background
            + w5·isOpenLoop(fact)                        // unpaid setups get priority
```

Take facts until the token budget is spent; always include, unconditionally:
the series premise, the current episode outline, the sheets of characters present in the scene,
and **the POV character's epistemic view**. Deterministic given the same graph state, so scene
generation is reproducible and testable.

### Continuity checking

Before an episode can move to `AIRED`:

1. **Extract** assertions from the new episode into candidate relations.
2. **Rule pass** (cheap, exact, no LLM): dead characters acting, objects in two places, timeline
   inversions, a character using knowledge they have no `knows` edge for, wardrobe/prop mismatch
   against the previous scene, age arithmetic.
3. **LLM pass** (semantic): tone drift, motivation contradictions, arc regressions.
4. Findings surface as `ContinuityIssue { severity, entities, conflictingFacts, suggestedFix }`.
   `error` blocks airing; `warning` does not.

Rules run first because they are free, exact, and catch the majority. The LLM only sees what the
rules could not decide.

---

## 5. What this buys the asset pipeline

Because the graph knows who appears where and when:

- **Asset demand is computed, not guessed** — the exact set of characters × wardrobes ×
  expressions × locations × props needed for an episode is a graph query, so the cost estimate is
  exact before a single dollar is spent.
- **Cross-episode reuse is automatic** — episode 4 asks for `char/kael/wardrobe-winter/angry`,
  the registry already has it from episode 2, cost `$0`.
- **Change propagation is precise** — "Kael loses an eye in E06" writes a relation with
  `validFrom = E06`; the resolver then serves the pre-E06 variant to earlier episodes and the
  post-E06 variant onward. No manual bookkeeping.
- **Style changes fork correctly** — the `StyleBible` checksum is part of every asset key, so a
  season-2 restyle regenerates assets while leaving season 1 intact and re-renderable.
