import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSpecifiers, packageNameOf, isAllowlisted, scanOverlay } from './lib.mjs';

const ts = createRequire(import.meta.url)('typescript');
const collect = (src) => collectSpecifiers(ts, src, 'sample.tsx');
const find = (src, spec) => collect(src).find((s) => s.spec === spec);

test('a used named import is a value import', () => {
  const src = `import { Link } from '@tanstack/react-router';\nexport const a = Link;`;
  assert.equal(find(src, '@tanstack/react-router').typeOnly, false);
});

test('an explicit import type is type-only', () => {
  const src = `import type { Foo } from 'pkg';\nexport type A = Foo;`;
  assert.equal(find(src, 'pkg').typeOnly, true);
});

test('every binding marked type is type-only', () => {
  const src = `import { type Foo, type Bar } from 'pkg';\nexport type A = Foo | Bar;`;
  assert.equal(find(src, 'pkg').typeOnly, true);
});

test('bindings used only in type positions are type-only (the elision rule)', () => {
  // This is the exact shape of b4m-bob src/api/bobRun.ts:15, which does NOT break the
  // build even though express does not resolve from the overlay.
  const src = [
    `import { Request, Response } from 'express';`,
    `export function h(req: Request, res: Response): void { res.end(); }`,
  ].join('\n');
  assert.equal(find(src, 'express').typeOnly, true);
});

test('one binding used in a value position makes the whole import a value import', () => {
  const src = [
    `import { Request, json } from 'express';`,
    `export function h(req: Request) { return json(); }`,
  ].join('\n');
  assert.equal(find(src, 'express').typeOnly, false);
});

test('a default import used as a value is a value import', () => {
  const src = `import express from 'express';\nexport const app = express();`;
  assert.equal(find(src, 'express').typeOnly, false);
});

test('a namespace import used as a value is a value import', () => {
  const src = `import * as path from 'pathlib';\nexport const p = path.join('a');`;
  assert.equal(find(src, 'pathlib').typeOnly, false);
});

test('a side-effect import is always a value import', () => {
  const src = `import 'polyfill-pkg';`;
  assert.equal(find(src, 'polyfill-pkg').typeOnly, false);
});

test('dynamic import is a value import', () => {
  const src = `export const load = () => import('lazy-pkg');`;
  assert.equal(find(src, 'lazy-pkg').typeOnly, false);
});

test('require is a value import', () => {
  const src = `const x = require('cjs-pkg');\nexport default x;`;
  assert.equal(find(src, 'cjs-pkg').typeOnly, false);
});

test('export from is captured, and export type from is type-only', () => {
  assert.equal(find(`export { a } from 'pkg-a';`, 'pkg-a').typeOnly, false);
  assert.equal(find(`export type { A } from 'pkg-b';`, 'pkg-b').typeOnly, true);
});

test('commented-out imports are not collected', () => {
  // The regex prototype failed here: it matched string literals and comments alike.
  const src = [
    `// import { Nope } from 'commented-pkg';`,
    `/* import { Also } from 'block-pkg'; */`,
    `export const joined = ['a', 'b'].join(', ');`,
    `export const arr = Array.from(', ');`,
  ].join('\n');
  const specs = collect(src).map((s) => s.spec);
  assert.deepEqual(specs, []);
});

test('line numbers are 1-indexed and point at the import', () => {
  const src = [`// header`, ``, `import { Link } from 'pkg';`, `export const a = Link;`].join('\n');
  assert.equal(find(src, 'pkg').line, 3);
});

test('a class extending an imported base is a value import', () => {
  // TS uses one node kind for `extends` and `implements`; the base class is a real runtime
  // value, so an undeclared base-class package must be reported.
  const src = `import { Base } from 'pkg';\nexport class Foo extends Base {}`;
  assert.equal(find(src, 'pkg').typeOnly, false);
});

test('a class implementing an imported interface stays type-only', () => {
  const src = `import { IBase } from 'pkg';\nexport class Foo implements IBase {}`;
  assert.equal(find(src, 'pkg').typeOnly, true);
});

test('an interface extending an imported interface stays type-only', () => {
  const src = `import { IBase } from 'pkg';\nexport interface Foo extends IBase {}`;
  assert.equal(find(src, 'pkg').typeOnly, true);
});

test('extends with type arguments is a value import, and the type argument is not a value use', () => {
  const src = [
    `import { Base } from 'pkg';`,
    `import { Row } from 'types-pkg';`,
    `export class Foo extends Base<Row> {}`,
  ].join('\n');
  assert.equal(find(src, 'pkg').typeOnly, false);
  assert.equal(find(src, 'types-pkg').typeOnly, true);
});

test('packageNameOf extracts scoped and unscoped names', () => {
  assert.equal(packageNameOf('@tanstack/react-router'), '@tanstack/react-router');
  assert.equal(packageNameOf('@tanstack/react-query/build/modern'), '@tanstack/react-query');
  assert.equal(packageNameOf('robots-parser'), 'robots-parser');
  assert.equal(packageNameOf('lodash/merge'), 'lodash');
});

test('packageNameOf returns null for non-package specifiers', () => {
  assert.equal(packageNameOf('./reportView'), null);
  assert.equal(packageNameOf('../llm-tools/panelRead'), null);
  assert.equal(packageNameOf('/abs/path'), null);
  assert.equal(packageNameOf('node:fs'), null);
  assert.equal(packageNameOf('fs'), null);
  assert.equal(packageNameOf('path'), null);
});

test('bundler-aliased specifiers are allowlisted', () => {
  // react is undeclared in every overlay and lives only in node_modules/.pnpm/node_modules,
  // which is NOT on the resolution walk from packages/premium/<name>. It works purely because
  // Next aliases it. Omitting these fails all six overlays on day one.
  for (const s of ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'next', 'next/router']) {
    assert.equal(isAllowlisted(s, []), true, s);
  }
});

test('host tsconfig path aliases are allowlisted', () => {
  assert.equal(isAllowlisted('@server/middlewares/baseApi', []), true);
  assert.equal(isAllowlisted('@client/components/Foo', []), true);
});

test('lookalikes are not allowlisted', () => {
  assert.equal(isAllowlisted('react-router', []), false);
  assert.equal(isAllowlisted('@tanstack/react-router', []), false);
  assert.equal(isAllowlisted('nextjs-toast', []), false);
  assert.equal(isAllowlisted('@servers/foo', []), false);
});

test('extraAllowlist matches exactly', () => {
  assert.equal(isAllowlisted('weird-pkg', ['weird-pkg']), true);
  assert.equal(isAllowlisted('weird-pkg/sub', ['weird-pkg']), false);
});

// Builds a throwaway host+overlay pair. `files` maps overlay-relative paths to contents.
function fixture({ overlayPkg, hostPkg, files }) {
  const root = mkdtempSync(join(tmpdir(), 'cod-'));
  const overlayRoot = join(root, 'packages', 'premium', 'sample');
  mkdirSync(overlayRoot, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify(hostPkg));
  writeFileSync(join(overlayRoot, 'package.json'), JSON.stringify(overlayPkg));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(overlayRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return { hostRoot: root, overlayRoot };
}

const HOST = { name: 'host', dependencies: { sst: '4.14.1' }, devDependencies: { '@types/aws-lambda': '8.10.162' } };
const scan = (f) => scanOverlay(ts, { ...f, extraAllowlist: [] });

test('an undeclared value import is an error', () => {
  const f = fixture({
    hostPkg: HOST,
    overlayPkg: { name: '@bike4mind/premium-sample' },
    files: {
      'src/spa/Report.tsx': `import { Link } from '@tanstack/react-router';\nexport const a = Link;`,
    },
  });
  const r = scan(f);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].name, '@tanstack/react-router');
  assert.equal(r.errors[0].file, 'src/spa/Report.tsx');
  assert.equal(r.errors[0].line, 1);
});

test('declaring it in the overlay manifest clears the error, in any dependency block', () => {
  for (const block of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const f = fixture({
      hostPkg: HOST,
      overlayPkg: { name: '@bike4mind/premium-sample', [block]: { '@tanstack/react-router': '^1.170.15' } },
      files: { 'src/spa/Report.tsx': `import { Link } from '@tanstack/react-router';\nexport const a = Link;` },
    });
    assert.equal(scan(f).errors.length, 0, block);
  }
});

test('a specifier declared only in the host root is a note, not an error', () => {
  // How `sst` resolves for b4m-optihashi: the walk from packages/premium/<name> reaches the
  // host root node_modules.
  const f = fixture({
    hostPkg: HOST,
    overlayPkg: { name: '@bike4mind/premium-sample' },
    files: { 'src/server/cron.ts': `import { Resource } from 'sst';\nexport const r = Resource;` },
  });
  const r = scan(f);
  assert.equal(r.errors.length, 0);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0].reason, /host root/);
});

test('a type-only import of @types/<name> from the host root is a note', () => {
  const f = fixture({
    hostPkg: HOST,
    overlayPkg: { name: '@bike4mind/premium-sample' },
    files: {
      'src/server/h.ts': `import { SQSEvent } from 'aws-lambda';\nexport function f(e: SQSEvent): void {}`,
    },
  });
  const r = scan(f);
  assert.equal(r.errors.length, 0);
  assert.equal(r.notes.length, 1);
});

test('a type-only import that resolves nowhere is a note, never an error', () => {
  const f = fixture({
    hostPkg: HOST,
    overlayPkg: { name: '@bike4mind/premium-sample' },
    files: {
      'src/api/run.ts': `import { Request } from 'express';\nexport function h(r: Request): void {}`,
    },
  });
  const r = scan(f);
  assert.equal(r.errors.length, 0);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0].reason, /type-only/);
});

test('the overlay may import itself by its own name', () => {
  const f = fixture({
    hostPkg: HOST,
    overlayPkg: { name: '@bike4mind/premium-sample' },
    files: {
      'src/spa/routes.ts': `import { x } from '@bike4mind/premium-sample/llm-tools';\nexport const y = x;`,
    },
  });
  assert.equal(scan(f).errors.length, 0);
});

test('a nested directory with its own package.json is skipped', () => {
  const f = fixture({
    hostPkg: HOST,
    overlayPkg: { name: '@bike4mind/premium-sample' },
    files: {
      'site/package.json': JSON.stringify({ name: 'sample-site' }),
      'site/src/main.ts': `import { createApp } from 'vue';\nexport const a = createApp;`,
      'src/index.ts': `export const ok = 1;`,
    },
  });
  const r = scan(f);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.skippedNested, ['site']);
});

test('node_modules is never scanned', () => {
  const f = fixture({
    hostPkg: HOST,
    overlayPkg: { name: '@bike4mind/premium-sample' },
    files: {
      'node_modules/junk/index.ts': `import { z } from 'totally-undeclared';\nexport const a = z;`,
      'src/index.ts': `export const ok = 1;`,
    },
  });
  assert.equal(scan(f).errors.length, 0);
});

test('scanned counts only the files it actually parsed', () => {
  const f = fixture({
    hostPkg: HOST,
    overlayPkg: { name: '@bike4mind/premium-sample' },
    files: { 'src/a.ts': `export const a = 1;`, 'src/b.tsx': `export const b = 2;`, 'README.md': `# no` },
  });
  assert.equal(scan(f).scanned, 2);
});
