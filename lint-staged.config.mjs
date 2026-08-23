import path from 'node:path';

const ROOT = process.cwd();

/**
 * Collapse a staged file list to the package roots that contain it.
 *
 * lint-staged passes every staged path to the command, and a large commit blows
 * through Windows' ~8 KB command-line limit — the hook then fails with
 * "The command line is too long" and tells you nothing about your code. Passing
 * `packages/<name>` / `apps/<name>` instead keeps the argument list to a couple of
 * dozen short paths however many files changed.
 *
 * The trade is that a commit touching one file in a package lints that whole package.
 * That is slower, but it is correct in the direction that matters: type-aware rules
 * see the real program, and a change that breaks a *neighbouring* file is caught at
 * commit rather than in CI.
 */
function toScopes(files) {
  const scopes = new Set();
  for (const file of files) {
    const relative = path.relative(ROOT, file).split(path.sep);
    // `packages/foo/src/x.ts` and `apps/bar/src/y.vue` collapse to their package root;
    // anything at the top level is passed through as itself.
    scopes.add(
      (relative[0] === 'packages' || relative[0] === 'apps') && relative[1] !== undefined
        ? `${relative[0]}/${relative[1]}`
        : relative.join('/'),
    );
  }
  return [...scopes];
}

function quote(scope) {
  return scope.includes(' ') ? `"${scope}"` : scope;
}

export default {
  '*.{ts,tsx,vue,js,mjs,cjs}': (files) => {
    const scopes = toScopes(files).map(quote).join(' ');
    return [
      `node --max-old-space-size=8192 ./node_modules/eslint/bin/eslint.js --fix ${scopes}`,
      `prettier --write ${scopes}`,
    ];
  },
  '*.{json,md,yml,yaml}': (files) => [`prettier --write ${toScopes(files).map(quote).join(' ')}`],
};
