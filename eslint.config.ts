
// eslint.config.ts
import * as ts from "npm:typescript";
import { resolve, dirname } from "node:path";

const globalState = {
  blockingFunctions: new Set<string>(),
  checkedFiles: new Set<string>(),
};

function createProgram(mainFile: string) {
  // Find all related files
  const files = new Set<string>();
  const host = ts.createCompilerHost({});

  function addFile(fileName: string) {
    if (files.has(fileName)) return;
    files.add(fileName);

    const sourceFile = ts.createSourceFile(
      fileName,
      ts.sys.readFile(fileName) || "",
      ts.ScriptTarget.ESNext
    );

    // Find imports
    ts.forEachChild(sourceFile, node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const importPath = resolve(dirname(fileName), node.moduleSpecifier.text);
        addFile(importPath + ".ts"); // Assuming .ts extension
      }
    });
  }

  addFile(mainFile);

  return ts.createProgram(Array.from(files), {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    allowJs: true,
  });
}

export default [
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    ignores: ["**/node_modules/**"],
    plugins: {
      custom: {
        rules: {
          "no-async-sync": {
            meta: {
              type: "suggestion",
            },
            create(context) {
              if (globalState.checkedFiles.has(context.filename)) {
                return {};
              }

              console.log("Analyzing file:", context.filename);

              // Create TypeScript program with all related files
              const program = createProgram(context.filename);
              const typeChecker = program.getTypeChecker();

              // Analyze all source files
              for (const sourceFile of program.getSourceFiles()) {
                if (!sourceFile.isDeclarationFile) {
                  console.log("Checking file:", sourceFile.fileName);
                  analyzeSourceFile(sourceFile);
                }
              }

              function analyzeSourceFile(sourceFile: ts.SourceFile) {
                function isDenoSyncCall(node: ts.CallExpression): boolean {
                  if (ts.isPropertyAccessExpression(node.expression)) {
                    const left = node.expression.expression;
                    const right = node.expression.name;
                    return (
                      ts.isIdentifier(left) &&
                      left.text === "Deno" &&
                      right.text.endsWith("Sync")
                    );
                  }
                  return false;
                }

                function findBlockingCalls(node: ts.Node) {
                  if (ts.isCallExpression(node)) {
                    // Check for Deno.*Sync calls
                    if (isDenoSyncCall(node)) {
                      let parent = node.parent;
                      while (parent && !ts.isFunctionDeclaration(parent)) {
                        parent = parent.parent;
                      }
                      if (parent && ts.isFunctionDeclaration(parent) && parent.name) {
                        const symbol = typeChecker.getSymbolAtLocation(parent.name);
                        if (symbol) {
                          const fullName = typeChecker.getFullyQualifiedName(symbol);
                          console.log(`Found Deno.*Sync in: ${fullName}`);
                          globalState.blockingFunctions.add(fullName);
                        }
                      }
                    }

                    // Check for calls to blocking functions
                    const signature = typeChecker.getResolvedSignature(node);
                    if (signature) {
                      const declaration = signature.declaration;
                      if (declaration && ts.isFunctionDeclaration(declaration)) {
                        const symbol = declaration.name &&
                          typeChecker.getSymbolAtLocation(declaration.name);
                        if (symbol) {
                          const fullName = typeChecker.getFullyQualifiedName(symbol);
                          if (globalState.blockingFunctions.has(fullName)) {
                            let parent = node.parent;
                            while (parent && !ts.isFunctionDeclaration(parent)) {
                              parent = parent.parent;
                            }
                            if (parent && ts.isFunctionDeclaration(parent) && parent.name) {
                              const parentSymbol = typeChecker.getSymbolAtLocation(parent.name);
                              if (parentSymbol) {
                                const parentName = typeChecker.getFullyQualifiedName(parentSymbol);
                                console.log(`Function ${parentName} calls blocking: ${fullName}`);
                                globalState.blockingFunctions.add(parentName);
                              }
                            }
                          }
                        }
                      }
                    }
                  }

                  ts.forEachChild(node, findBlockingCalls);
                }

                findBlockingCalls(sourceFile);
                globalState.checkedFiles.add(sourceFile.fileName);
              }

              return {
                FunctionDeclaration(node) {
                  if (node.async && node.id?.name) {
                    const funcName = node.id.name;
                    // Check both local and fully qualified names
                    if (globalState.blockingFunctions.has(funcName) ||
                        Array.from(globalState.blockingFunctions).some(name =>
                          name.endsWith("." + funcName))) {
                      context.report({
                        node,
                        message: "Async function contains blocking operations",
                      });
                    }
                  }
                },

                "Program:exit"() {
                  console.log("Blocking functions:", Array.from(globalState.blockingFunctions));
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
