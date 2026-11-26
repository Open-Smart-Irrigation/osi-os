import ts from 'typescript';

export function sourceFile(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

export function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

function propertyChain(node) {
  if (!node) return '';
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return propertyChain(node.expression);
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return propertyChain(node.expression) + '.' + node.argumentExpression.text;
  }
  if (ts.isPropertyAccessExpression(node)) return propertyChain(node.expression) + '.' + node.name.text;
  if (ts.isMetaProperty(node)) return node.getText();
  return '';
}

function isCreateRequire(node) {
  return ts.isCallExpression(node) && /(?:^|\.)createRequire$/.test(propertyChain(node.expression));
}

export function imports(source, {resolveTemplates = false} = {}) {
  const found = [];
  const constants = new Map();
  if (resolveTemplates) {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const {name, initializer} of statement.declarationList.declarations) {
        if (ts.isIdentifier(name) && initializer && ts.isStringLiteralLike(initializer)) constants.set(name.text, initializer.text);
      }
    }
  }

  const requireFunctions = new Set(['require', 'require.resolve', 'module.require', 'globalThis.require', 'import.meta.resolve']);
  // Include calls via the local name returned by Node's createRequire.
  walk(source, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isCreateRequire(node.initializer)) {
      requireFunctions.add(node.name.text);
      requireFunctions.add(node.name.text + '.resolve');
    }
  });
  function staticSpecifier(node) {
    if (node && ts.isStringLiteralLike(node)) return node.text;
    if (!resolveTemplates || !node || !ts.isTemplateExpression(node)) return undefined;
    let value = node.head.text;
    for (const {expression, literal} of node.templateSpans) {
      if (!ts.isIdentifier(expression) || !constants.has(expression.text)) return undefined;
      value += constants.get(expression.text) + literal.text;
    }
    return value;
  }

  function record(node, specifier) {
    found.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      specifier: staticSpecifier(specifier),
    });
  }
  walk(source, node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) record(node, node.moduleSpecifier);
    } else if (ts.isExternalModuleReference(node)) {
      record(node, node.expression);
    } else if (ts.isImportTypeNode(node)) {
      record(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    } else if (ts.isCallExpression(node)) {
      const {expression} = node;
      const called = propertyChain(expression);
      if (expression.kind === ts.SyntaxKind.ImportKeyword || requireFunctions.has(called) || isCreateRequire(expression)) {
        record(node, node.arguments[0]);
      } else if (called === 'import.meta.glob' || called === 'import.meta.globEager') {
        // A glob is Vite-specific and the caller must account for its expansion.
        record(node, undefined);
      } else if (isCreateRequire(node)) {
        const [anchor] = node.arguments;
        if (anchor && ts.isNewExpression(anchor) && propertyChain(anchor.expression) === 'URL'
            && propertyChain(anchor.arguments?.[1]) === 'import.meta.url') record(node, anchor.arguments[0]);
      }
    }
  });
  return found;
}
