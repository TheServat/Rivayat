# ADR-0004: A Graphiti-shaped bi-temporal narrative graph, on SQLite

**Status:** Accepted — 2026-08-23. Realised by `@rv/narrative-memory`. Storage substrate shared
with ADR-0006.

## Context

A single short needs no memory: the whole story fits in one prompt. A **series** does not. By
episode 6 the scene writer needs to know who is alive, who is where, who is carrying what, who
believes a lie, and which setup from episode 2 is still unpaid — and it needs that as a _bounded_
context, not a dump of everything written so far.

Flat-string memory (what every "idea → video" pipeline we surveyed uses, see
[`00b-prior-art.md` §A](../00b-prior-art.md)) fails at exactly this point. There is no queryable
world model, so continuity is whatever survived in the transcript.

The harder half of the problem is temporal, and it is specific to fiction.

### Two clocks, and why one is not enough

| Clock                                             | Question it answers                                          |
| ------------------------------------------------- | ------------------------------------------------------------ |
| **Story time** (`validFrom` / `validUntil`)       | When was this true _inside the fiction_?                     |
| **Authoring time** (`assertedAt` / `retractedAt`) | When did _we_ decide it, and is that decision still current? |

Serialised fiction retro-fits backstory constantly. In episode 7 we decide that in episode 2 the
mentor was already lying. That single, entirely normal authoring act is unrepresentable with one
clock:

- **Story time only** — the fact is stamped "true from year 1204". Nothing records that we did not
  know it while writing episode 2, so we cannot answer "what was episode 2 written against?", we
  cannot diff canon over authoring history, and an audit of what changed when is impossible.
- **Authoring time only** — the fact is stamped "added on 2026-08-23". Nothing records _when in
  the story_ it holds, so "who was alive in year 1204" and "what did the audience know at the end
  of episode 3" have no answer, and contradiction detection has nothing to compare intervals on.
- **Overwriting in place** — corrupts episode 2's asserted canon, which non-negotiable #7 forbids
  for an `AIRED` episode.

Two clocks handle it natively: the fact gets `validFrom = <story time in E02>` and
`assertedAt = <when we wrote E07>`. Both questions stay answerable, and nothing is destroyed.

## Decision

Implement a **bi-temporal knowledge graph, taxonomically modelled on
[Graphiti/Zep](https://arxiv.org/abs/2501.13956)**, directly on **SQLite** inside
`@rv/narrative-memory`. No graph database, no external service.

Adopted from Graphiti wholesale:

- `EpisodicNode` — the raw source utterance or scene text.
- `EntityNode` — a resolved entity (`character`, `location`, `prop`, `faction`, `concept`, …).
- `EntityEdge` — a **fact**, carrying human-readable fact text plus its embedding.
- `CommunityNode` — an auto-clustered group (a household, a faction, a subplot) with a rolling
  LLM summary, which is what keeps retrieval cheap as the graph grows.
- **Bi-temporality on every edge** — the four timestamps above.

Added for fiction, and not present in Graphiti:

- **An epistemic edge layer.** What is _true_ and what each character _believes_ are separate
  edges (`knows`, `believes-falsely`, `suspects`, `witnessed`, `told`). The scene writer for
  episode 5 is handed **the POV character's** view of the graph, not the narrator's, so a
  character cannot act on information they do not have. This one mechanism removes the most
  common failure mode of LLM-written serials, and it is what makes dramatic irony mechanically
  possible rather than accidental.
- **`visibility: public | private | secret`** — what the _audience_ knows, tracked separately
  again, so reveals can be scheduled.
- **Signed `strength: -1..1`** on affinity edges, which drives the relationship matrix and flags
  arcs that never actually change.

Retrieval is hybrid (graph proximity + embedding similarity + story recency + entity importance +
open-loop priority), **budgeted**, and **deterministic given the same graph state** — so scene
generation is reproducible and testable. Full scoring function in
[`02-domain-model.md` §4](../02-domain-model.md).

Embeddings come from local Ollama (`nomic-embed-text`), so the semantic half costs nothing and
needs no key.

## Consequences

**Positive.** Queries that are otherwise impossible become one-liners: "what did the audience know
at the end of episode 3" is a query at story-time T with authoring-time now; "what does Kael know"
is the same query filtered by his `knows` edges; contradiction detection is an interval overlap
between incompatible facts. Asset demand becomes a graph query rather than a guess, which is what
makes the pre-spend cost estimate exact (ADR-0002). Zero operational surface: the graph is a file
in the workspace, backed up by copying it, and a series is portable by copying one directory.

**Negative.** We implement graph traversal, k-hop scoring and community detection ourselves, on
top of SQL, rather than getting them from a graph engine. Recursive CTEs are workable but not
free, and deep multi-hop queries on a large series will need materialised paths or a hop cap —
we accept a bounded `k` rather than unbounded traversal. Bi-temporality doubles the timestamp
surface on every write path and is genuinely easy to get subtly wrong; the invariants
(`validFrom <= validUntil`, `assertedAt <= retractedAt`, no two contradicting facts with
overlapping validity _and_ both currently asserted) are enforced in `core-domain` and tested to
100 %. There is no off-the-shelf visualiser; the graph UI is ours to build.

## Alternatives considered

**Zep / Graphiti as a running service, backed by Neo4j.** The reference implementation, and we are
copying its data model, so this was the default choice. Rejected on **operations**: it requires a
Neo4j instance (JVM, several GB of RAM on a 32 GB machine that also runs Ollama and ComfyUI) plus
the Zep service alongside it. This project is **local-first and zero-ops** — clone, `pnpm install`,
run. Requiring two servers before a user can write episode 1 is a worse product. We take the data
model, which is the valuable part, and leave the deployment topology.

**Mem0.** Rejected on **its own published numbers**: Mem0's paper reports its graph variant is
roughly **3× slower** and costs about **2× the tokens** of its base configuration, while scoring
_worse_ on both single-hop and multi-hop retrieval. That is the dual-store design paying a large
price for a negative result. We do not copy it. (Recorded in `00b-prior-art.md` §C.)

**Letta / MemOS, Cognee.** Rejected: both are general-purpose agent-memory systems with their own
service and runtime assumptions. Neither has bi-temporality, which is the requirement that
actually drove this decision, and neither would tolerate the epistemic layer without being fought.

**Plain vector store (embeddings + similarity only).** Rejected: it answers "what is similar to
this" and nothing else. It cannot answer "who was alive in year 1204", cannot detect a
contradiction, cannot represent that a fact stopped being true, and has no notion of a character's
private view. Semantic similarity is _one term_ of our retrieval score, not the whole of it.

**Full-text search over the scripts.** Rejected: cheapest possible option and genuinely useful as a
fallback, but it retrieves _text_, not _facts_. It cannot enforce continuity, cannot be queried at
a story time, and degrades exactly as the series gets long enough to need it.

**One clock plus an append-only edit log.** Rejected: this is bi-temporality with the second clock
hidden in a log that nothing can query. Every interesting question ("what did E02 assert _at the
time_") requires replaying the log, which is slower and more error-prone than storing the second
interval on the edge where it belongs.

**Neo4j embedded / an embedded graph engine (e.g. Kùzu).** Closer to viable than the service
options, and worth revisiting. Rejected now for **substrate consistency**: ADR-0006 already puts
all metadata in SQLite behind repository interfaces. Running a second embedded database for the
graph means two files, two backup stories, two migration stories, and no transaction spanning
both — a real cost for a series where an episode transition must write graph edges and entity rows
atomically.
