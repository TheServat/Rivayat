#!/usr/bin/env node
// Thin launcher so `rv` works before anything is built: tsx resolves the workspace
// `development` export condition straight to source.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(
  process.execPath,
  [
    resolve(here, '../../../node_modules/tsx/dist/cli.mjs'),
    resolve(here, '../src/main.ts'),
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);
child.on('close', (code) => process.exit(code ?? 0));
