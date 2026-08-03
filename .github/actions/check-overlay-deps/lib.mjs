// Pure logic for the check-overlay-deps gate. No process, no argv, no console.
//
// The TypeScript module is INJECTED rather than imported so the action can borrow the host
// tree's copy (adding no dependency to any consumer) while tests supply their own.

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
