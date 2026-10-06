#!/usr/bin/env node
// orm.mjs
// Single entry point for all tools.
//
// Usage:
//   node tools/orm.mjs <command> [args...]
//   node tools/orm.mjs --help
//
// Commands:
//   audit      Run audit-svg.mjs
//   check      Run check-yaml.mjs
//   optimize   Run optimize-svg.mjs
//   resize     Run resize-svg.mjs
//   aspects    Run generate-aspects.mjs
//
// Implementation note:
//   spawnSync is used instead of spawn() or import(). It blocks until the
//   child terminates, inherits stdio directly, and leaves no background
//   event loop running. This avoids two Windows-specific pitfalls:
//     - Ctrl+C not propagating cleanly to a spawned child,
//     - the parent exiting before the child has flushed its output.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const COMMANDS = {
  'audit': { file: 'audit-svg.mjs', desc: 'HTML/text/JSON audit of symbols/fr' },
  'check': { file: 'check-yaml.mjs', desc: 'Static analysis of the YAML' },
  'optimize': { file: 'optimize-svg.mjs', desc: 'Text-to-path + SVGO on symbols/fr' },
  'resize': { file: 'resize-svg.mjs', desc: 'Set width/height from viewBox' },
  'aspects': { file: 'generate-aspects.mjs', desc: 'Generate overlay SVGs (numbers, signal aspects) from templates' },
  'clean-templates': { file: 'clean-templates.mjs', desc: 'Resolve leftover transforms on the aspect templates' },
};

function printHelp() {
  console.log('Usage: node tools/orm.mjs <command> [args...]\n');
  console.log('Commands:');
  for (const [name, { desc }] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(12)} ${desc}`);
  }
  console.log('\nRun a command with --help for its specific options:');
  console.log('  node tools/orm.mjs audit --help');
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === '-h' || cmd === '--help') { printHelp(); process.exit(0); }
if (!COMMANDS[cmd]) {
  console.error(`✗ Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

const targetPath = join(__dirname, COMMANDS[cmd].file);

const result = spawnSync(
  process.execPath,
  [targetPath, ...rest],
  { stdio: 'inherit', windowsHide: false },
);

// spawnSync sets result.error when the child could not be launched at all
// (e.g. process.execPath not found). Distinguish that from a non-zero exit.
if (result.error) {
  console.error(`✗ Failed to launch ${COMMANDS[cmd].file}:`);
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
