#!/usr/bin/env node
/**
 * The CI/local contract.
 *
 * `pnpm verify` is the gate (CLAUDE.md §5). The failure mode this script exists to stop
 * is the ordinary one: someone adds a step to `verify` and not to the workflow, or the
 * other way round, and from then on "green locally" and "green in CI" mean different
 * things. So the workflow does not run `pnpm verify` as one opaque command — it runs the
 * same steps individually, so a failure is attributable — and this script proves the two
 * lists are the same list.
 *
 * It also holds three smaller invariants that only bite in CI:
 *   - the Node version has one source of truth (`.nvmrc`), and it satisfies `engines`
 *   - the workflow pins no tool version of its own
 *   - no paid-provider credential is visible to a CI job (CI spends $0)
 *
 * Usage:  node tools/scripts/verify-drift-check.mjs
 * Exit:   0 consistent, 1 drift found, 2 the script could not do its job.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WORKFLOW = '.github/workflows/ci.yml';
const BEGIN = 'verify:steps:begin';
const END = 'verify:steps:end';

/**
 * Credentials that cost money. A CI job holding one of these is one bad test away from a
 * bill, and the whole provider layer is designed to run against recorded fixtures.
 * Non-negotiable #3 says cost is metered before it is spent; in CI the budget is zero.
 */
const PAID_CREDENTIALS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'REPLICATE_API_TOKEN',
  'FAL_KEY',
];

const problems = [];
const read = (relative) => readFileSync(resolve(REPO_ROOT, relative), 'utf8');

function fail(what, detail) {
  problems.push({ what, detail });
}

/** `pnpm run a && pnpm run b` -> ['a', 'b']. Anything else in the chain is a problem. */
function stepsInVerifyScript(verify) {
  const steps = [];
  for (const part of verify.split('&&').map((s) => s.trim())) {
    const match = /^pnpm run ([\w:-]+)$/.exec(part);
    if (match === null) {
      fail(
        'package.json scripts.verify',
        `"${part}" is not a plain \`pnpm run <script>\`. CI runs each step as its own ` +
          `job step; an inline command cannot be mirrored, so give it a named script.`,
      );
      continue;
    }
    steps.push(match[1]);
  }
  return steps;
}

/** The `run: pnpm run <script>` lines between the two markers, in order. */
function stepsInWorkflow(yaml) {
  const begin = yaml.indexOf(BEGIN);
  const end = yaml.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    fail(WORKFLOW, `missing the \`${BEGIN}\` / \`${END}\` markers around the verify steps`);
    return null;
  }
  const region = yaml.slice(begin, end);
  return [...region.matchAll(/^\s*run:\s*pnpm run ([\w:-]+)\s*$/gm)].map((m) => m[1]);
}

/** Minimal, on purpose: it understands `>=x.y.z` and refuses anything it does not. */
function satisfiesMinimum(version, range) {
  const spec = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (spec === null) return null;
  const actual = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (actual === null) return null;
  for (let i = 1; i <= 3; i += 1) {
    const a = Number(actual[i]);
    const b = Number(spec[i]);
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function main() {
  const pkg = JSON.parse(read('package.json'));
  const yaml = read(WORKFLOW);

  // 1. The verify chain and the workflow run the same steps in the same order.
  const verify = pkg.scripts?.verify;
  if (typeof verify !== 'string') {
    fail('package.json', 'no `scripts.verify`');
  } else {
    const local = stepsInVerifyScript(verify);
    const ci = stepsInWorkflow(yaml);
    if (ci !== null && local.join(' -> ') !== ci.join(' -> ')) {
      fail(
        'CI/verify drift',
        `pnpm verify runs [${local.join(', ')}]\n` +
          `    ${WORKFLOW} runs [${ci.join(', ')}]\n` +
          `    Change both, or neither.`,
      );
    }
  }

  // 2. One source of truth for the Node version, and it satisfies `engines`.
  const nvmrc = read('.nvmrc').trim();
  const engines = pkg.engines?.node;
  if (typeof engines !== 'string') {
    fail('package.json', 'no `engines.node`');
  } else {
    const ok = satisfiesMinimum(nvmrc, engines);
    if (ok === null) {
      fail(
        'engines.node',
        `cannot compare .nvmrc "${nvmrc}" against "${engines}". This check only ` +
          `understands \`>=x.y.z\`; teach it the new form rather than deleting it.`,
      );
    } else if (!ok) {
      fail('engines.node', `.nvmrc pins ${nvmrc}, which does not satisfy "${engines}"`);
    }
  }

  // 3. The workflow pins no tool version of its own.
  if (/^\s*node-version:\s*['"]?\d/m.test(yaml)) {
    fail(
      WORKFLOW,
      'hardcodes `node-version:`. Use `node-version-file: .nvmrc` so the version has one home.',
    );
  }
  if (/pnpm\/action-setup@[^\n]*\n(?:[^\n]*\n)?\s*with:\s*\n\s*version:/m.test(yaml)) {
    fail(
      WORKFLOW,
      'pins a pnpm `version:`. Leave it out so the action reads `packageManager` from package.json.',
    );
  }

  // 4. CI spends $0. Only enforced under CI: a developer's shell legitimately has keys.
  if (process.env.CI === 'true') {
    const present = PAID_CREDENTIALS.filter((name) => (process.env[name] ?? '') !== '');
    if (present.length > 0) {
      fail(
        'CI budget',
        `${present.join(', ')} is set in a CI job. No test may reach a paid provider; ` +
          `the provider contract suite runs on recorded fixtures. Remove the secret from ` +
          `the workflow, do not skip the test.`,
      );
    }
  }

  if (problems.length > 0) {
    for (const p of problems) {
      if (process.env.GITHUB_ACTIONS === 'true') {
        console.error(`::error title=${p.what}::${p.detail.replace(/\n/g, ' ')}`);
      }
      console.error(`  x ${p.what}\n    ${p.detail}`);
    }
    console.error(`\nverify-drift-check: ${problems.length} problem(s).`);
    process.exit(1);
  }

  console.log('verify-drift-check: clean — CI runs exactly the steps `pnpm verify` runs.');
}

try {
  main();
} catch (error) {
  console.error('verify-drift-check: failed to run');
  console.error(error);
  process.exit(2);
}
