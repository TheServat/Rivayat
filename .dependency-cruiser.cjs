/**
 * Architecture fitness function.
 *
 * The Clean/Hexagonal dependency rule from docs/01-architecture.md is not a
 * convention here - it is a build failure. Arrows point inward only:
 *
 *   apps  ->  engines/application  ->  core-domain / contracts  ->  shared-kernel
 *   infrastructure (providers, persistence) implements ports, is never imported by core.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make the layering unprovable and break tree-shaking.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: ['\\.d\\.ts$', '(^|/)(index|main)\\.ts$', '\\.config\\.(ts|js)$'],
      },
      to: {},
    },
    {
      name: 'core-domain-is-pure',
      severity: 'error',
      comment:
        'core-domain must have zero outward dependencies: no SDKs, no node builtins, no sibling packages except shared-kernel and contracts.',
      from: { path: '^packages/core-domain/src', pathNot: '\\.(spec|test)\\.ts$' },
      to: {
        pathNot: [
          '^packages/core-domain/src',
          '^packages/shared-kernel/src',
          '^packages/contracts/src',
          'node_modules/(zod|@rv/)',
        ],
      },
    },
    {
      name: 'shared-kernel-is-dependency-free',
      severity: 'error',
      comment:
        'shared-kernel is the bottom of the stack: nothing from npm, nothing from the workspace. Node core (crypto) is allowed - hashing and CSPRNG have no reasonable pure-JS alternative. Spec files are exempt: the purity rule is about shipped code, and every test imports vitest.',
      from: { path: '^packages/shared-kernel/src', pathNot: '\\.(spec|test)\\.ts$' },
      to: {
        pathNot: ['^packages/shared-kernel/src'],
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'contracts-only-zod',
      severity: 'error',
      comment: 'contracts is the schema source of truth; it may only use zod and shared-kernel.',
      from: { path: '^packages/contracts/src', pathNot: '\\.(spec|test)\\.ts$' },
      to: {
        pathNot: ['^packages/contracts/src', '^packages/shared-kernel/src', 'node_modules/zod'],
      },
    },
    {
      name: 'engines-must-not-import-provider-sdks',
      severity: 'error',
      comment:
        'Application-layer engines depend on ports, never on a vendor SDK. Add an adapter in packages/providers instead.',
      from: {
        path: '^packages/(style|story|asset|anim|render)-engine/src',
      },
      to: {
        path: 'node_modules/(@google/genai|openai|ollama|@nestjs|playwright|sharp|pixi\\.js)',
      },
    },
    {
      name: 'no-core-to-infrastructure',
      severity: 'error',
      comment: 'Domain and application layers must not reach into apps/ or persistence details.',
      from: { path: '^packages/(core-domain|contracts|shared-kernel)/src' },
      to: { path: '^(apps|packages/(providers|persistence))/' },
    },
    {
      name: 'web-has-no-server-code',
      severity: 'error',
      comment: 'The Vue app talks to the API over HTTP; it never imports server-only packages.',
      from: { path: '^apps/web/src' },
      to: {
        path: '^(apps/api|packages/(providers|asset-registry|render-engine)/src)',
      },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment: 'Production code must not import a devDependency.',
      from: { path: '^(packages|apps)/[^/]+/src', pathNot: '\\.(spec|test)\\.ts$' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-deprecated-core',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|domain|sys|constants)$' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    // Build output is a projection of src; cruising it would make the result
    // depend on whether a build has run, and `dist/*.d.cts` shows up as an orphan.
    exclude: { path: '(^|/)(dist|coverage|\\.turbo|__fixtures__)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(@[^/]+/[^/]+|[^/]+)' },
      archi: { collapsePattern: '^(packages|apps)/[^/]+' },
    },
  },
};
