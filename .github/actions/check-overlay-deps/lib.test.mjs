import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { collectSpecifiers } from './lib.mjs';

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
