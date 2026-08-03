// Pure logic for the check-overlay-deps gate. No process, no argv, no console.
//
// The TypeScript module is INJECTED rather than imported so the action can borrow the host
// tree's copy (adding no dependency to any consumer) while tests supply their own.

import { builtinModules, createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// TypeScript uses ExpressionWithTypeArguments for BOTH `class C extends Base`, where Base is a
// real runtime value that builds the prototype chain, and `class C implements I` /
// `interface I extends J`, which are fully erased. ts.isTypeNode() reports "type" for all
// three, so without this the base class of every `extends` looks erasable and an undeclared
// base-class package would pass the gate silently.
function isValueHeritage(ts, node) {
  if (!ts.isExpressionWithTypeArguments(node)) return false;
  const clause = node.parent;
  if (!clause || !ts.isHeritageClause(clause)) return false;
  if (clause.token !== ts.SyntaxKind.ExtendsKeyword) return false;
  const decl = clause.parent;
  return !!decl && (ts.isClassDeclaration(decl) || ts.isClassExpression(decl));
}

// Every identifier appearing in a VALUE position in this file. An import binding absent from
// this set is erased by SWC/tsc before the bundler resolves anything, which is why
// `import { Request, Response } from 'express'` never breaks a build even though `express`
// does not resolve from the overlay. Reproducing that elision rule is what keeps the gate
// free of false positives; without it, `express`, `aws-lambda` and `sst` are reported as
// build-breakers on four of six overlays and the gate gets switched off.
function valuePositionIdentifiers(ts, sf) {
  const names = new Set();
  const walk = (node, inType) => {
    const isTypeContext =
      inType ||
      (ts.isTypeNode(node) && !isValueHeritage(ts, node)) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeParameterDeclaration(node);
    if (ts.isIdentifier(node) && !isTypeContext) {
      // Binding sites are declarations, not uses.
      const p = node.parent;
      const isBindingSite =
        p && (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p));
      if (!isBindingSite) names.add(node.text);
    }
    ts.forEachChild(node, (c) => walk(c, isTypeContext));
  };
  ts.forEachChild(sf, (c) => walk(c, false));
  return names;
}

export function collectSpecifiers(ts, sourceText, fileName) {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const valueUsed = valuePositionIdentifiers(ts, sf);
  const out = [];

  const record = (node, spec, typeOnly) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ spec, typeOnly, line: line + 1 });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      // No clause at all is a side-effect import (`import 'x'`): always emitted.
      let typeOnly = false;
      if (clause) {
        if (clause.isTypeOnly) {
          typeOnly = true;
        } else {
          const bindings = [];
          if (clause.name) bindings.push({ name: clause.name.text, isTypeOnly: false });
          const nb = clause.namedBindings;
          if (nb && ts.isNamedImports(nb)) {
            for (const el of nb.elements) bindings.push({ name: el.name.text, isTypeOnly: el.isTypeOnly });
          } else if (nb && ts.isNamespaceImport(nb)) {
            bindings.push({ name: nb.name.text, isTypeOnly: false });
          }
          typeOnly = bindings.length > 0 && !bindings.some((b) => !b.isTypeOnly && valueUsed.has(b.name));
        }
      }
      record(node, node.moduleSpecifier.text, typeOnly);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record(node, node.moduleSpecifier.text, node.isTypeOnly);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      record(node, node.arguments[0].text, false);
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return out;
}

// Specifiers a bundler rewrites before resolution ever happens. See the test for why this
// list is load-bearing rather than a convenience.
const BUNDLER_ALIASED = [
  /^react$/,
  /^react-dom(\/.*)?$/,
  /^react\/jsx-runtime$/,
  /^react\/jsx-dev-runtime$/,
  /^next(\/.*)?$/,
];

// Host tsconfig `paths` entries. Not packages at all.
const HOST_ALIASES = [/^@server(\/.*)?$/, /^@client(\/.*)?$/];

export function packageNameOf(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (builtinModules.includes(name)) return null;
  return name;
}

export function isAllowlisted(spec, extraAllowlist) {
  if (extraAllowlist.includes(spec)) return true;
  return BUNDLER_ALIASED.some((r) => r.test(spec)) || HOST_ALIASES.some((r) => r.test(spec));
}

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

// A nested directory with its own package.json is a separate package carrying its own
// declarations, so measuring it against the overlay's manifest asks the wrong question.
// Discovered rather than hardcoded: today this finds bob/site, tavern/cc-bridge,
// optihashi/engine and optihashi/engine-container.
function nestedPackageRoots(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const child = join(dir, entry.name);
    try {
      statSync(join(child, 'package.json'));
      acc.push(child);
      continue; // it owns everything below it
    } catch {
      nestedPackageRoots(child, acc);
    }
  }
  return acc;
}

function sourceFiles(dir, nested, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || nested.includes(p)) continue;
      sourceFiles(p, nested, acc);
    } else if (SOURCE_EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      acc.push(p);
    }
  }
  return acc;
}

const manifestNames = (pkg) => [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
];

// Real resolution from the importing file's own directory. Only meaningful once node_modules
// exists; additive, never the sole authority, so the gate still works before install.
function resolvesFrom(fileAbsPath, spec) {
  try {
    createRequire(fileAbsPath).resolve(spec);
    return true;
  } catch {
    return false;
  }
}

export function scanOverlay(ts, { overlayRoot, hostRoot, extraAllowlist = [] }) {
  const overlayPkg = JSON.parse(readFileSync(join(overlayRoot, 'package.json'), 'utf8'));
  const hostPkg = JSON.parse(readFileSync(join(hostRoot, 'package.json'), 'utf8'));
  const overlayDeclared = new Set([...manifestNames(overlayPkg), overlayPkg.name]);
  const hostRootDeclared = new Set(manifestNames(hostPkg));

  const nested = nestedPackageRoots(overlayRoot);
  const files = sourceFiles(overlayRoot, nested);
  const errors = [];
  const notes = [];

  for (const file of files) {
    const rel = relative(overlayRoot, file);
    const specs = collectSpecifiers(ts, readFileSync(file, 'utf8'), file);
    for (const { spec, typeOnly, line } of specs) {
      if (isAllowlisted(spec, extraAllowlist)) continue;
      const name = packageNameOf(spec);
      if (!name) continue;
      if (overlayDeclared.has(name)) continue;

      const hit = { file: rel, line, spec, name };
      if (hostRootDeclared.has(name) || (typeOnly && hostRootDeclared.has(`@types/${name}`))) {
        notes.push({ ...hit, reason: `satisfied by the host root${typeOnly ? ' (type-only)' : ''}` });
        continue;
      }
      if (resolvesFrom(file, spec)) {
        notes.push({ ...hit, reason: 'resolves from the installed tree' });
        continue;
      }
      if (typeOnly) {
        notes.push({ ...hit, reason: 'type-only and resolves nowhere: typecheck debt, cannot break the build' });
        continue;
      }
      errors.push(hit);
    }
  }

  return {
    overlayName: overlayPkg.name,
    scanned: files.length,
    skippedNested: nested.map((n) => relative(overlayRoot, n)),
    errors,
    notes,
  };
}
