import { defineConfig } from 'tsup';

/**
 * The app is bundled, like every package in the workspace, rather than emitted with
 * `tsc`.
 *
 * The reason is the module system. Source here uses extensionless relative imports,
 * because `tsconfig.base.json` sets `moduleResolution: "Bundler"` and every other
 * package in the repo is built the same way. Emitting that with `tsc` under
 * `NodeNext` would need a `.js` suffix on several hundred import specifiers - a
 * repo-wide convention change to make one app's build work.
 *
 * ESM only, no CJS: both consumers are this repo, and both are ESM.
 *
 * **Two entries, and the second is not an afterthought.** `main.ts` is the server;
 * `public.ts` is the orchestration surface `apps/cli` imports so that `rv run` and
 * `POST /api/runs` drive the *same* `PipelineRunner` rather than two implementations of
 * it that drift. `dts` is therefore on - there is now a consumer to hand types to, and
 * it is the slowest step of the build for exactly that reason.
 */
export default defineConfig({
  entry: ['src/main.ts', 'src/public.ts'],
  format: ['esm'],
  dts: { entry: 'src/public.ts' },
  sourcemap: true,
  clean: true,
  // Off: Nest resolves providers by the tokens on their `@Inject`s, and shaking a
  // module graph whose entry points are decorators is a class of bug nobody wants to
  // debug at boot. The output is a local program, not a payload over a network.
  treeshake: false,
  target: 'node22',
  // `better-sqlite3` is a native addon and `@nestjs/core` lazily `require`s its
  // platform adapter; both must stay external. tsup externalises `dependencies` by
  // default, which covers them - this is here so removing a dependency from
  // `package.json` does not silently pull it into the bundle.
  external: ['better-sqlite3', '@nestjs/platform-express', 'bullmq', 'ioredis'],
});
