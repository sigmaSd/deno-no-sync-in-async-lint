import ts from "npm:typescript@5.7.2";
import * as path from "jsr:@std/path@1.0.8";

export interface AnalyzerState {
  blockingFunctions: Set<string>;
  importMap: Map<string, { source: string; name: string }>;
  analyzedFiles: Map<string, Set<string>>;
  functionCalls: Map<string, Set<string>>;
}

export class TypeScriptAnalyzer {
  private state: AnalyzerState = {
    blockingFunctions: new Set<string>(),
    importMap: new Map<string, { source: string; name: string }>(),
    analyzedFiles: new Map<string, Set<string>>(),
    functionCalls: new Map<string, Set<string>>(),
  };

  private normalizeImportPath(
    importSpecifier: string,
    currentFile: string,
  ): string {
    if (!importSpecifier.startsWith(".")) {
      return importSpecifier;
    }

    const currentDir = path.dirname(currentFile);
    const resolvedPath = path.resolve(currentDir, importSpecifier);
    return /\.[^/.]+$/.test(resolvedPath) ? resolvedPath : `${resolvedPath}.ts`;
  }

  private addFunctionCall(caller: string, callee: string) {
    if (!this.state.functionCalls.has(caller)) {
      this.state.functionCalls.set(caller, new Set());
    }
    this.state.functionCalls.get(caller)?.add(callee);
  }

  private markAsBlocking(funcName: string) {
    this.state.blockingFunctions.add(funcName);

    // Mark all functions that call this function as blocking
    for (const [caller, callees] of this.state.functionCalls.entries()) {
      if (callees.has(funcName)) {
        this.markAsBlocking(caller);
      }
    }
  }

  analyzeFile(filePath: string, visited = new Set<string>()) {
    const absolutePath = path.resolve(filePath);

    if (visited.has(absolutePath)) {
      return this.state.analyzedFiles.get(absolutePath) || new Set();
    }

    visited.add(absolutePath);
    try {
      const content = Deno.readTextFileSync(absolutePath);
      const sourceFile = ts.createSourceFile(
        absolutePath,
        content,
        ts.ScriptTarget.Latest,
        true,
      );

      const blockingFuncs = new Set<string>();

      // First pass: collect imports
      const analyzeImports = (node: ts.Node) => {
        if (ts.isImportDeclaration(node)) {
          const source = node.moduleSpecifier.getText().replace(/['"]/g, "");
          if (source.startsWith(".")) {
            const importPath = this.normalizeImportPath(source, absolutePath);

            if (node.importClause?.namedBindings) {
              if (ts.isNamedImports(node.importClause.namedBindings)) {
                node.importClause.namedBindings.elements.forEach((element) => {
                  const localName = element.name.text;
                  const importedName = element.propertyName?.text ||
                    element.name.text;
                  this.state.importMap.set(localName, {
                    source: importPath,
                    name: importedName,
                  });
                });
              }
            }

            if (!visited.has(importPath)) {
              this.analyzeFile(importPath, visited);
            }
          }
        }
      };

      ts.forEachChild(sourceFile, analyzeImports);

      // Second pass: analyze functions and calls
      let currentFunction: string | undefined;

      const visit = (node: ts.Node) => {
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
          if (node.name && ts.isIdentifier(node.name)) {
            currentFunction = node.name.text;
          }
        } else if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          (ts.isFunctionExpression(node.initializer) ||
            ts.isArrowFunction(node.initializer))
        ) {
          currentFunction = node.name.text;
        }

        if (currentFunction) {
          if (ts.isCallExpression(node)) {
            const expr = node.expression;
            if (
              ts.isPropertyAccessExpression(expr) &&
              ts.isIdentifier(expr.expression) &&
              expr.expression.text === "Deno" &&
              ts.isIdentifier(expr.name) &&
              expr.name.text.endsWith("Sync")
            ) {
              blockingFuncs.add(currentFunction);
              this.markAsBlocking(currentFunction);
            } else if (ts.isIdentifier(expr)) {
              this.addFunctionCall(currentFunction, expr.text);

              // Check if calling a known blocking function
              if (this.state.blockingFunctions.has(expr.text)) {
                this.markAsBlocking(currentFunction);
              }
            } else if (
              ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)
            ) {
              this.addFunctionCall(currentFunction, expr.name.text);
            }
          }
        }

        ts.forEachChild(node, visit);

        if (
          (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
          node.name
        ) {
          currentFunction = undefined;
        }
      };

      ts.forEachChild(sourceFile, visit);

      // Final pass: check imported functions
      for (const [localName, importInfo] of this.state.importMap.entries()) {
        const sourceBlockingFuncs = this.state.analyzedFiles.get(
          importInfo.source,
        );
        if (sourceBlockingFuncs?.has(importInfo.name)) {
          this.markAsBlocking(localName);
        }
      }

      this.state.analyzedFiles.set(absolutePath, blockingFuncs);
      return blockingFuncs;
    } catch (error) {
      console.error(`Error analyzing ${absolutePath}:`, error);
      return new Set();
    }
  }

  isBlockingFunction(name: string): boolean {
    return this.state.blockingFunctions.has(name);
  }

  getState(): AnalyzerState {
    return this.state;
  }
}

if (import.meta.main) {
  const analyzer = new TypeScriptAnalyzer();
  const filePath = Deno.args[0];
  if (!filePath) {
    console.error("Please provide a file path to analyze");
    Deno.exit(1);
  }

  analyzer.analyzeFile(filePath);

  console.log("\nAnalysis Results:");
  console.log("----------------");
  console.log(
    "\nBlocking functions:",
    [
      ...analyzer.getState().blockingFunctions,
    ].sort(),
  );

  console.log("\nImport map:");
  const sortedImports = [...analyzer.getState().importMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of sortedImports) {
    console.log(`  ${key} -> ${value.source} (${value.name})`);
  }

  console.log("\nFunction calls:");
  const sortedCalls = [...analyzer.getState().functionCalls.entries()]
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [func, calls] of sortedCalls) {
    console.log(`  ${func} calls: [${[...calls].sort().join(", ")}]`);
  }
}
