import { defineConfig } from 'drizzle-kit';

/**
 * Migration generation.
 *
 * Lives at the package root rather than beside the migrations it produces because
 * everything under `src/` is compiled application code: a config there would be inside
 * the tsconfig program, would import a devDependency, and would fail the
 * `not-to-dev-dep` rule in `pnpm arch:check`. The other tool configs (`tsup`,
 * `vitest`) sit here for the same reason.
 *
 * The output *is* committed. A migration that is generated at install time is a
 * migration nobody has read, and ADR-0006 makes the same file the narrative graph and
 * the cost ledger live in.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema/index.ts',
  out: './src/migrations',
  strict: true,
  verbose: true,
});
