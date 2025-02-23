import * as ts from "npm:typescript";
import parser from "npm:@typescript-eslint/parser";

const globalState = {
  blockingFunctions: new Set<string>(),
  importMap: new Map<string, { source: string; name: string }>(),
  analyzedFiles: new Map<string, Set<string>>(),
  analyzedPaths: new Set<string>(),
};

function resolveImportPath(importSpecifier: string, currentFile: string): string {
  const dir = currentFile.replace(/\/[^/]+$/, '');
  const resolved = importSpecifier.startsWith('.')
    ? `${dir}/${importSpecifier.replace(/^\.\//, '')}`
    : importSpecifier;
  const result = resolved.endsWith('.ts') ? resolved : `${resolved}.ts`;
  console.log(`Resolved import path: ${importSpecifier} -> ${result}`);
  return result;
}

function findBlockingFunctionsInTypescript(sourceFile: ts.SourceFile): Set<string> {
  const blockingFuncs = new Set<string>();
  let currentFunction: string | undefined;

  function visit(node: ts.Node) {
    // Track current function
    if (ts.isFunctionDeclaration(node) && node.name) {
      currentFunction = node.name.text;
    }

    // Check for Deno.*Sync calls
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
          console.log(`Found Deno.*Sync in function: ${currentFunction}`);
          blockingFuncs.add(currentFunction);
        }
      }
    }

    // Recursively visit all children
    node.forEachChild(visit);

    // Reset current function when leaving its scope
    if (ts.isFunctionDeclaration(node) && node.name) {
      currentFunction = undefined;
    }
  }

  visit(sourceFile);

  if (blockingFuncs.size > 0) {
    console.log(`Found blocking functions:`, Array.from(blockingFuncs));
  }

  return blockingFuncs;
}
function analyzeDenoSyncCalls(filePath: string): Set<string> {
  console.log(`\nAnalyzing file: ${filePath}`);

  if (globalState.analyzedPaths.has(filePath)) {
    const cached = globalState.analyzedFiles.get(filePath);
    console.log(`Using cached results for ${filePath}:`, Array.from(cached || []));
    return cached || new Set();
  }

  try {
    console.log(`Reading file: ${filePath}`);
    const content = Deno.readTextFileSync(filePath);
    globalState.analyzedPaths.add(filePath);

    console.log(`Creating source file for: ${filePath}`);
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    const blockingFuncs = findBlockingFunctionsInTypescript(sourceFile);

    // Add to global state
    for (const func of blockingFuncs) {
      console.log(`Adding ${func} to global blocking functions`);
      globalState.blockingFunctions.add(func);
    }

    globalState.analyzedFiles.set(filePath, blockingFuncs);
    console.log(`Analysis complete. Found:`, Array.from(blockingFuncs));

    return blockingFuncs;
  } catch (error) {
    console.error(`Error analyzing ${filePath}:`, error);
    return new Set();
  }
}

function isBlockingFunction(name: string): boolean {
  // Direct check
  if (globalState.blockingFunctions.has(name)) {
    console.log(`${name} is directly blocking`);
    return true;
  }

  // Check imported function
  const importInfo = globalState.importMap.get(name);
  if (importInfo) {
    console.log(`${name} is imported from ${importInfo.source} as ${importInfo.name}`);

    // Check if the imported function is blocking
    const sourceBlockingFuncs = globalState.analyzedFiles.get(importInfo.source);
    if (sourceBlockingFuncs?.has(importInfo.name)) {
      console.log(`${name} is blocking (imported function ${importInfo.name} is blocking)`);
      // Add to global blocking functions for future checks
      globalState.blockingFunctions.add(name);
      return true;
    }

    // Check if the original name is in global blocking functions
    if (globalState.blockingFunctions.has(importInfo.name)) {
      console.log(`${name} is blocking (original name ${importInfo.name} is blocking)`);
      globalState.blockingFunctions.add(name);
      return true;
    }
  }

  return false;
}


export default [
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    ignores: ["**/node_modules/**"],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
          custom: {
            rules: {
              "no-async-sync": {
                meta: {
                  type: "suggestion",
                },
                create(context) {
                  const currentFileBlockingFuncs = new Set<string>();

                  return {
                    Program(node) {
                      currentFileBlockingFuncs.clear();
                      console.log("\nAnalyzing file:", context.filename);
                    },

                    ImportDeclaration(node) {
                      const source = node.source.value;
                      const importPath = resolveImportPath(source, context.filename);
                      console.log(`Processing import from ${source} (${importPath})`);

                      for (const specifier of node.specifiers) {
                        if (specifier.type === "ImportSpecifier") {
                          const localName = specifier.local.name;
                          const importedName = specifier.imported.name;
                          globalState.importMap.set(localName, {
                            source: importPath,
                            name: importedName
                          });
                          console.log(`Imported ${localName} from ${importPath} as ${importedName}`);
                        }
                      }

                      const blockingFuncs = analyzeDenoSyncCalls(importPath);
                      if (blockingFuncs.size > 0) {
                        globalState.analyzedFiles.set(importPath, blockingFuncs);
                        console.log(`Found blocking functions in ${importPath}:`, Array.from(blockingFuncs));
                      }
                    },

                    CallExpression(node) {
                      // Check for direct Deno.*Sync calls
                      if (
                        node.callee?.type === "MemberExpression" &&
                        node.callee.object?.name === "Deno" &&
                        node.callee.property?.name?.endsWith("Sync")
                      ) {
                        let current = node;
                        while (current && current.type !== "FunctionDeclaration") {
                          current = current.parent;
                        }
                        if (current?.id?.name) {
                          const funcName = current.id.name;
                          console.log(`Found Deno.*Sync in: ${funcName}`);
                          currentFileBlockingFuncs.add(funcName);
                          globalState.blockingFunctions.add(funcName);
                        }
                      }

                      // Check for calls to blocking functions
                      if (node.callee?.type === "Identifier") {
                        const calledName = node.callee.name;
                        if (isBlockingFunction(calledName)) {
                          let current = node;
                          while (current && current.type !== "FunctionDeclaration") {
                            current = current.parent;
                          }
                          if (current?.id?.name) {
                            const funcName = current.id.name;
                            console.log(`Function ${funcName} calls blocking function: ${calledName}`);
                            currentFileBlockingFuncs.add(funcName);
                            globalState.blockingFunctions.add(funcName);
                          }
                        }
                      }
                    },

                    FunctionDeclaration(node) {
                      if (node.async && node.id?.name) {
                        const funcName = node.id.name;
                        if (isBlockingFunction(funcName)) {
                          console.log(`Reporting blocking async function: ${funcName}`);
                          context.report({
                            node,
                            message: "Async function contains blocking operations",
                          });
                        }
                      }
                    },

                    "Program:exit"() {
                      console.log("\nSummary:");
                      console.log("Current file blocking functions:", Array.from(currentFileBlockingFuncs));
                      console.log("All blocking functions:", Array.from(globalState.blockingFunctions));
                      console.log("Analyzed files:",
                        Object.fromEntries(
                          Array.from(globalState.analyzedFiles.entries())
                            .map(([k, v]) => [k, Array.from(v)])
                        )
                      );
                      console.log("Import map:",
                        Object.fromEntries(
                          Array.from(globalState.importMap.entries())
                            .map(([k, v]) => [k, v])
                        )
                      );
                    }
                  };
                }
              }
            }
          }
        },
    rules: {
      "custom/no-async-sync": "error"
    }
  }
];
