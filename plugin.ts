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
    return resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
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

        // Helper function to find the actual blocking call node
        function findBlockingNodes(
          node: ts.Node,
          visited = new Set<string>(),
        ): ts.Node[] {
          const blockingNodes: ts.Node[] = [];

          function visit(node: ts.Node) {
            if (ts.isCallExpression(node)) {
              const expr = node.expression;
              // Check for direct Deno.*Sync calls
              if (
                ts.isPropertyAccessExpression(expr) &&
                ts.isIdentifier(expr.expression) &&
                expr.expression.text === "Deno" &&
                ts.isIdentifier(expr.name) &&
                expr.name.text.endsWith("Sync")
              ) {
                blockingNodes.push(node);
              } else if (ts.isIdentifier(expr)) {
                const calledName = expr.text;
                if (globalState.blockingFunctions.has(calledName)) {
                  blockingNodes.push(node);
                }
              }
            }
            node.forEachChild((child) => visit(child));
          }

          visit(node);
          return blockingNodes;
        }

        return {
          Program() {
            if (!analyzed) {
              analyzeTypeScriptFile(context.filename);
              analyzed = true;
            }
          },

          "FunctionDeclaration[async=true]"(node) {
            if (node.id?.name) {
              const funcName = node.id.name;
              if (isBlockingFunction(funcName)) {
                // Find all blocking nodes within the function
                const blockingNodes = findBlockingNodes(node);

                // Report each blocking operation individually
                for (const blockingNode of blockingNodes) {
                  context.report({
                    node: blockingNode,
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
