#!/usr/bin/env node
// argv -> scanOverlay -> GitHub annotations -> exit code. No logic lives here.
//
// typescript is resolved from the HOST tree, not installed: every consumer of this action
// already runs pnpm install on a workspace that has it, so the gate adds no dependency.
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { scanOverlay } from './lib.mjs';

const [overlayPath, hostRootArg, extraRaw] = process.argv.slice(2);
if (!overlayPath) {
  console.error('usage: cli.mjs <overlay_path> [host_root] [extra_allowlist]');
  process.exit(2);
}
const hostRoot = resolve(hostRootArg || '.');
const overlayRoot = resolve(overlayPath);
const extraAllowlist = (extraRaw || '').split(/\s+/).filter(Boolean);

let ts;
try {
  ts = createRequire(join(hostRoot, 'noop.js'))('typescript');
} catch {
  console.log(
    `::error::check-overlay-deps could not resolve 'typescript' from ${hostRoot}. ` +
      'This step must run AFTER pnpm install, so the host tree provides the compiler.'
  );
  process.exit(1);
}

const r = scanOverlay(ts, { overlayRoot, hostRoot, extraAllowlist });

console.log(`check-overlay-deps: ${r.overlayName}, ${r.scanned} files`);
if (r.skippedNested.length) console.log(`  skipped nested packages: ${r.skippedNested.join(', ')}`);
for (const n of r.notes) console.log(`  note  ${n.file}:${n.line}  '${n.spec}'  ${n.reason}`);

for (const e of r.errors) {
  console.log(
    `::error file=${overlayPath}/${e.file},line=${e.line}::${r.overlayName} imports '${e.spec}' as a value, ` +
      `but '${e.name}' resolves neither from this overlay nor from the host root. The bundler will fail on ` +
      `this once the overlay is hydrated. Declare '${e.name}' in ${r.overlayName}'s package.json ` +
      `(peerDependencies + devDependencies if the host already owns the copy).`
  );
}

if (r.errors.length) {
  console.log(`check-overlay-deps FAILED: ${r.errors.length} unresolvable value import(s)`);
  process.exit(1);
}
console.log('check-overlay-deps OK: every value import resolves');
