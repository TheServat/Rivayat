# Rivayat — working agreement

Read this before touching code. Every agent working in this repo follows it.

**What we are building:** an idea becomes an animated, multi-episode series. Art style is
locked first, the story and its world model come next, visual assets are generated **once** and
reused forever, animation is **procedural** on rigs, and the result renders to YouTube /
Shorts / Reels / TikTok formats from one composition.

Design documents, in reading order:

| Doc                                                | Contents                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [docs/00-research.md](docs/00-research.md)         | Verified tool/provider/pricing research. **Numbers here are live-checked — do not "correct" them from memory.** |
| [docs/00b-prior-art.md](docs/00b-prior-art.md)     | What we copied from ViMax / Graphiti / DOC / CHIRON, and what we deliberately rejected                          |
| [docs/01-architecture.md](docs/01-architecture.md) | Layering, package map, the four core models, the pipeline, providers                                            |
| [docs/02-domain-model.md](docs/02-domain-model.md) | Series/episodes, the bi-temporal narrative graph, narrative memory                                              |
| [docs/adr/](docs/adr/)                             | Decisions with their reasoning. Read the relevant ADR before relitigating one.                                  |

---

## 1. Non-negotiables

These are the load-bearing invariants. Breaking one is a bug even if tests pass.

1. **Determinism.** No `Date.now()`, no `Math.random()`, no wall-clock reads in domain or
   application code. Inject `Clock`; use `createRng(seed)` from `@rv/shared-kernel`. Renders must
   be bit-reproducible and pipeline runs must be replayable.
2. **No asset is generated twice.** Every generation goes through the registry's dedup key
   (`semanticKey + styleChecksum + variantKey + specHash`). A second take requires an explicit
   `RegenerateIntent`, and it creates a new `AssetVersion` — it never overwrites.
3. **Cost is metered before it is spent.** Every provider call records
   `{provider, model, tokens, images, nanoUsd}`. The budget guard runs _before_ the call.
4. **The dependency rule.** Arrows point inward: `apps → engines → core-domain/contracts →
shared-kernel`. Domain and application layers never import a vendor SDK. `pnpm arch:check`
   enforces this and fails CI.
5. **Zod is the single source of truth.** Types are _inferred_ from schemas in `@rv/contracts`,
   never hand-written alongside them. JSON Schema for LLM structured output and OpenAPI for the
   API are both _emitted_ from the same schemas.
6. **LLM JSON only via `StructuredCall`.** Ollama does not reliably enforce schemas on
   `qwen3.5`/`gemma4` (see research §1). Never call a model for JSON directly; use the wrapper
   with its parse → validate → repair → escalate loop.
7. **Aired canon is immutable.** An episode in the `AIRED` state cannot have its asserted facts
   contradicted, only extended or revealed. The continuity checker enforces it.

## 2. Code standards

- **TypeScript 6.0.3**, `strict` plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Not TS 7 — it has no compiler API, which breaks `nest build`,
  the Swagger plugin and type-aware ESLint (see `docs/adr/ADR-0005`).
- **No `any`, no `!` non-null assertions, no unexplained `@ts-expect-error`.** ESLint blocks all
  three. Use `at()`, `must()`, `assertDefined()` from `@rv/shared-kernel` instead.
- **`Result<T, E>` for expected failures**, thrown `AppError` only for programmer error. Adapters
  convert exceptions to `Result` exactly once, at the boundary.
- **One class per use-case**, named `<Verb><Noun>UseCase` with a single `execute()`.
- **Ports are narrow.** Do not add a method to an existing port because it is convenient; add a
  new port. An adapter that cannot implement a capability declares it, and the router routes
  around it.
- **No `switch` on a provider/format/style name in core.** Register an implementation in a map;
  the union stays exhaustive via `assertNever`.
- Comments explain _why_, never _what_. Match the density of the surrounding file.

## 3. Testing

Every package carries its own `vitest.config.ts` with a `name`. Run one with
`cd packages/<pkg> && npx vitest run`, everything with `pnpm test`.

| Layer                                     | Expectation                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `core-domain`, `contracts`, `anim-engine` | **100 %** — pure, no IO, no excuse                                                             |
| everything else                           | 90 % lines / 85 % branches                                                                     |
| Providers                                 | Must pass the shared contract suite (LSP guard) with recorded fixtures — no live network in CI |
| Animation                                 | Golden-file tests: `AnimationIR → frame hash`                                                  |

Write tests that assert **behaviour and invariants**, not implementation shape. A test that
would still pass after the function is gutted is not a test. Assert on structured fields, not on
message wording.

## 4. Commands

```bash
pnpm install
pnpm verify        # format + lint + typecheck + arch + test — must be green before "done"
pnpm test          # all packages
pnpm arch:check    # dependency rule
pnpm --filter @rv/<pkg> build
```

## 5. Definition of done

A task is done when **all** of these hold:

1. `pnpm verify` is green.
2. New public API has TSDoc explaining _why_ it exists.
3. Tests cover the happy path, the failure path, and the boundary the code actually guards.
4. No new dependency without a line in the ADR or research doc saying why.
5. The acceptance criteria in `docs/03-backlog.md` for the story are satisfied.

Report honestly: if something is partial, say which part and why. Do not report "done" on
work that has not been run.
