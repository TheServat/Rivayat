# ADR-0005: Pin TypeScript 6.0.3, not 7.x

**Status:** Accepted — 2026-08-23. **Revisit when the TS 7 compiler API ships.**

## Context

TypeScript 7 is the Go port of the compiler. It is dramatically faster and it is what
`npm install typescript` gives you today.

Verified live against the registry on 2026-08-23:

```
$ npm view typescript dist-tags
{ "latest": "7.0.2", "next": "7.1.0-dev.20260823.1", "beta": "6.0.0-beta", "rc": "7.0.1-rc" }
```

The problem is what `typescript@7.0.2` actually ships. Its `exports` map, from the same query:

```json
{
  ".": "./lib/version.cjs",
  "./unstable/ast": "./dist/ast/index.js",
  "./unstable/fs": "./dist/api/fs.js",
  "./unstable/sync": "./dist/api/sync/api.js",
  "./unstable/async": "./dist/api/async/api.js",
  "./unstable/proto": "./dist/api/proto.js",
  "./unstable/ast/{is,clone,utils,factory,scanner,visitor}": "…"
}
```

**The root export is the version string.** `import ts from 'typescript'` no longer yields
`createProgram`, `transpileModule`, `createSourceFile`, `getTypeChecker`, the transformer
pipeline, or the language service. What exists is a set of explicitly `unstable/` AST and
filesystem endpoints. The `bin` map contains `tsc` and **not** `tsserver`. The package is a thin
wrapper over 20 platform-native binaries (`@typescript/typescript-win32-x64`, …).

Everything in our stack that consumes TypeScript _as a library_ therefore breaks:

| Consumer                                                                 | What it needs                                                                                                                 |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `nest build`                                                             | `ts.createProgram` + the transformer pipeline                                                                                 |
| NestJS **Swagger CLI plugin**                                            | A custom TS transformer — it reads decorators and JSDoc to synthesise the OpenAPI DTOs, and there is no other way to get them |
| `ts-jest` / `ts-loader`                                                  | `ts.transpileModule` / the language service                                                                                   |
| **Type-aware ESLint** (`recommendedTypeChecked`, `stylisticTypeChecked`) | The full type checker via the program/project service                                                                         |

That last row is not optional here. `CLAUDE.md` §2 forbids `any`, non-null assertions and
unexplained `@ts-expect-error`, and the rules that enforce the interesting half of our standards —
`no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`,
`no-unnecessary-condition` — are **all type-aware**. Without a compiler API there is no type-aware
linting, and a large part of the working agreement becomes unenforceable.

`typescript-eslint` states the boundary explicitly. Live from the registry:

```
$ npm view typescript-eslint@8.67.0 peerDependencies
{ "eslint": "^8.57.0 || ^9.0.0 || ^10.0.0", "typescript": ">=4.8.4 <6.1.0" }
```

TS 7 is outside that range by declaration, not by accident.

## Decision

**Pin `typescript: 6.0.3` exactly**, in the `catalog:` block of `pnpm-workspace.yaml`, so every
package in the workspace resolves the same compiler. `.npmrc` sets `save-exact=true`; there is no
caret.

Revisit when the TS 7 compiler API is no longer `unstable/` **and** `typescript-eslint` widens its
peer range to admit it. Both conditions, not either.

### One TS 6 accommodation we had to make

`baseUrl` is deprecated in TS 6 (`TS5101`) and removed in TS 7. We declare none — `paths` in
`tsconfig.base.json` are relative, which is how `paths` has resolved since TS 4.4 anyway. But
**tsup 8.5.1 hard-injects `baseUrl: compilerOptions.baseUrl || "."`** into the compiler options
for its declaration build (`tsup/dist/rollup.js:6837`), which makes every `pnpm build` fail with
TS5101. `tsconfig.base.json` therefore carries `"ignoreDeprecations": "6.0"` with a comment
saying exactly this. It tolerates tsup's injection; it does not license us to add a `baseUrl`.

## Consequences

**Positive.** `nest build`, the Swagger plugin, type-aware ESLint and every TS-consuming tool work
as documented. One compiler version across the workspace via the catalog, so there is no
skew between what CI typechecks and what the editor reports (`.vscode/settings.json` points at
the workspace SDK for the same reason). `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes` are available and on.

**Negative.** We forgo the Go compiler's speed, which is the entire reason TS 7 exists — a real
cost that grows with the codebase. We are on a version that will stop receiving fixes once the
ecosystem completes its migration, and we carry `ignoreDeprecations: "6.0"` as debt that must be
removed before any TS 7 move. This ADR has a deliberate expiry: it is a _timing_ decision, not a
preference, and leaving it unrevisited is itself a failure.

**Follow-up we can take at any time, at no risk:** run **TS 7 side-by-side purely as a
typechecker**. `tsc --noEmit` needs no compiler API — only the binary. Adding
`typescript-go` (or `typescript@7` under an alias) as a dev dependency and wiring a
`typecheck:fast` script gives the speed win for the inner loop, while TS 6 remains the compiler of
record for `pnpm build`, the Swagger plugin and ESLint. The two must be kept on compatible
`compilerOptions` or the fast check reports errors the real build does not — so this is worth
doing only with a shared `tsconfig.base.json`, which we have. Not wired up yet; recorded so it is
not rediscovered.

## Alternatives considered

**Adopt TypeScript 7.0.2 now.** Rejected: it breaks `nest build`, the Swagger CLI plugin, and
type-aware ESLint, and `typescript-eslint@8.67.0` refuses it by peer range. "Latest" is not a
reason; a working build is.

**TS 7 with type-aware linting disabled.** Rejected: this trades the compiler for the working
agreement. `no-floating-promises` and `switch-exhaustiveness-check` are load-bearing for
correctness in an async, union-heavy codebase, and dropping them to gain build speed is a bad
trade at any speed. It also does not fix `nest build` or the Swagger plugin.

**TS 7 with `nest build` replaced by `tsup`/`swc` for the API.** Rejected: `tsup`/`swc` can emit
the JavaScript, but the **Swagger CLI plugin is a TypeScript transformer**. Losing it means
hand-writing the OpenAPI decorators that we currently derive, which contradicts non-negotiable #5
(schemas are the single source of truth and OpenAPI is _emitted_). It also does not restore
type-aware ESLint.

**TS 5.x.** Rejected: strictly worse than 6.0.3 with no compensating benefit. TS 6 is the
designated migration release — it turns the TS 7 removals into deprecation errors, which is
exactly the position we want to be in when we do move.

**Float the version (`^6.0.0`).** Rejected: `.npmrc` sets `save-exact=true` deliberately.
A compiler minor is a behavioural change in a repo where CI must reproduce local results exactly;
we bump it on purpose, in a commit, or not at all.
