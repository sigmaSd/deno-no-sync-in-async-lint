import ts from "npm:typescript@5.7.2";

const globalState = {
  blockingFunctions: new Set<string>(),
  importMap: new Map<string, { source: string; name: string }>(),
  analyzedFiles: new Map<string, Set<string>>(),
  functionCalls: new Map<string, Set<string>>(),
};

function normalizeImportPath(
  importSpecifier: string,
  currentFile: string,
): string {
  const ensureAbsolute = (path: string) =>
    path.startsWith("/") ? path : `/${path}`;

  if (!importSpecifier.startsWith(".")) {
    return importSpecifier;
  }

  const currentDir = currentFile.replace(/\/[^/]+$/, "");
  try {
    const url = new URL(
      importSpecifier,
      `file://${ensureAbsolute(currentDir)}/`,
    );
    const resolved = decodeURIComponent(url.pathname);
    // Only append .ts if the path doesn't already have an extension
    return /\.[^/.]+$/.test(resolved) ? resolved : `${resolved}.ts`;
  } catch (error) {
    console.error(
      `Error normalizing path ${importSpecifier} relative to ${currentDir}:`,
      error,
    );
    return importSpecifier;
  }
}

function analyzeTypeScriptFile(filePath: string, visited = new Set<string>()) {
  if (visited.has(filePath)) {
    return globalState.analyzedFiles.get(filePath) || new Set();
  }

  visited.add(filePath);
  try {
    const content = Deno.readTextFileSync(filePath);
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
    );

    // Analyze imports first
    sourceFile.forEachChild((node) => {
      if (ts.isImportDeclaration(node)) {
        const source = node.moduleSpecifier.getText().replace(/['"]/g, "");
        if (source.startsWith(".")) {
          const importPath = normalizeImportPath(source, filePath);

          node.importClause?.namedBindings?.forEachChild((specifier) => {
            if (ts.isImportSpecifier(specifier)) {
              const localName = specifier.name.text;
              const importedName =
                (specifier.propertyName || specifier.name).text;
              globalState.importMap.set(localName, {
                source: importPath,
                name: importedName,
              });

              if (!visited.has(importPath)) {
                analyzeTypeScriptFile(importPath, visited);
              }
            }
          });
        }
      }
    });

    // Analyze function calls and blocking operations
    const blockingFuncs = new Set<string>();
    let currentFunction: string | undefined;

    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        currentFunction = node.name.text;
        if (!globalState.functionCalls.has(currentFunction)) {
          globalState.functionCalls.set(currentFunction, new Set());
        }
      }

      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        if (
          ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === "Deno" &&
          ts.isIdentifier(expr.name) &&
          expr.name.text.endsWith("Sync")
        ) {
          if (currentFunction) {
            blockingFuncs.add(currentFunction);
            globalState.blockingFunctions.add(currentFunction);
          }
        } else if (ts.isIdentifier(expr) && currentFunction) {
          const calledName = expr.text;
          globalState.functionCalls.get(currentFunction)?.add(calledName);
        }
      }

      node.forEachChild(visit);

      if (ts.isFunctionDeclaration(node) && node.name) {
        currentFunction = undefined;
      }
    };

    visit(sourceFile);
    globalState.analyzedFiles.set(filePath, blockingFuncs);
    return blockingFuncs;
  } catch (error) {
    console.error(`Error analyzing ${filePath}:`, error);
    return new Set();
  }
}

export default {
  name: "sync-checker",
  rules: {
    "no-async-sync": {
      create(context) {
        let analyzed = false;

        function isBlockingFunction(
          name: string,
          visited = new Set<string>(),
        ): boolean {
          if (visited.has(name)) return false;
          visited.add(name);

          if (globalState.blockingFunctions.has(name)) {
            return true;
          }

          // Check imported functions
          const importInfo = globalState.importMap.get(name);
          if (importInfo) {
            const sourceBlockingFuncs = globalState.analyzedFiles.get(
              importInfo.source,
            );
            if (sourceBlockingFuncs?.has(importInfo.name)) {
              globalState.blockingFunctions.add(name);
              return true;
            }
          }

          // Check function calls
          const calls = globalState.functionCalls.get(name);
          if (calls) {
            for (const callee of calls) {
              if (!visited.has(callee) && isBlockingFunction(callee, visited)) {
                globalState.blockingFunctions.add(name);
                return true;
              }
            }
          }

          return false;
        }

        return {
          Program() {
            if (!analyzed) {
              analyzeTypeScriptFile(context.filename);
              analyzed = true;
            }
          },

          "CallExpression"(node) {
            // Check if we're inside an async function
            // @ts-ignore parent does exist
            let parent = node.parent;
            while (parent && parent.type !== "FunctionDeclaration") {
              parent = parent.parent;
            }

            if (parent?.type === "FunctionDeclaration" && parent.async) {
              const funcName = parent.id?.name;
              if (funcName && isBlockingFunction(funcName)) {
                // Check if this call is a blocking operation
                if (
                  node.callee.type === "MemberExpression" &&
                  node.callee.object.type === "Identifier" &&
                  node.callee.object.name === "Deno" &&
                  node.callee.property.type === "Identifier" &&
                  node.callee.property.name.endsWith("Sync")
                ) {
                  context.report({
                    node,
                    message:
                      `Blocking operation found in async function '${funcName}'`,
                  });
                } else if (
                  node.callee.type === "Identifier" &&
                  globalState.blockingFunctions.has(node.callee.name)
                ) {
                  context.report({
                    node,
                    message:
                      `Blocking operation found in async function '${funcName}'`,
                  });
                }
              }
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
