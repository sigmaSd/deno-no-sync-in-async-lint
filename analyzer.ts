// analyzer.ts
import ts from "npm:typescript@5.7.2";
import * as path from "jsr:@std/path@1.0.8";

interface FunctionLocation {
  file: string;
  line: number;
  column: number;
}

export interface AnalyzerState {
  blockingFunctions: Set<string>;
  analyzedFiles: Map<string, Set<string>>;
  functionCalls: Map<string, Set<string>>;
  functionLocations: Map<string, FunctionLocation>;
}

export class TypeScriptAnalyzer {
  private state: AnalyzerState = {
    blockingFunctions: new Set<string>(),
    analyzedFiles: new Map<string, Set<string>>(),
    functionCalls: new Map<string, Set<string>>(),
    functionLocations: new Map<string, FunctionLocation>(),
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

  private markAsBlocking(funcName: string, visited = new Set<string>()) {
    if (visited.has(funcName)) {
      return;
    }

    visited.add(funcName);
    this.state.blockingFunctions.add(funcName);

    for (const [caller, callees] of this.state.functionCalls.entries()) {
      if (callees.has(funcName)) {
        this.markAsBlocking(caller, visited);
        if (!this.state.functionLocations.has(caller)) {
          const location = this.state.functionLocations.get(funcName);
          if (location) {
            this.state.functionLocations.set(caller, location);
          }
        }
      }
    }
  }

  private analyzeSourceFile(
    sourceFile: ts.SourceFile,
    filePath: string,
    visited: Set<string>,
  ): Set<string> {
    const blockingFuncs = new Set<string>();
    let currentFunction: string | undefined;

    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
        if (node.name && ts.isIdentifier(node.name)) {
          currentFunction = node.name.text;
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(),
          );
          this.state.functionLocations.set(node.name.text, {
            file: filePath,
            line: line + 1,
            column: character + 1,
          });
        }
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isFunctionExpression(node.initializer) ||
          ts.isArrowFunction(node.initializer))
      ) {
        currentFunction = node.name.text;
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(),
        );
        this.state.functionLocations.set(node.name.text, {
          file: filePath,
          line: line + 1,
          column: character + 1,
        });
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
    return blockingFuncs;
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

      const analyzeImports = (node: ts.Node) => {
        if (ts.isImportDeclaration(node)) {
          const source = node.moduleSpecifier.getText().replace(/['"]/g, "");
          if (source.startsWith(".")) {
            const importPath = this.normalizeImportPath(source, absolutePath);
            this.analyzeFile(importPath, visited);
          }
        }
      };

      ts.forEachChild(sourceFile, analyzeImports);

      const blockingFuncs = this.analyzeSourceFile(
        sourceFile,
        absolutePath,
        visited,
      );
      this.state.analyzedFiles.set(absolutePath, blockingFuncs);
      return blockingFuncs;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        console.error(`Skipping analyzing ${absolutePath}: File not found`);
      } else {
        console.error(`Error analyzing ${absolutePath}:`, error);
      }
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
  const state = analyzer.getState();
  const blockingFunctions = [...state.blockingFunctions].sort();

  if (blockingFunctions.length > 0) {
    console.log(
      "\nWarning: Found blocking functions in the following locations:",
    );
    blockingFunctions.forEach((func) => {
      const location = state.functionLocations.get(func);
      if (location) {
        console.log(
          `  - ${func} (in ${location.file}:${location.line}:${location.column})`,
        );
      } else {
        console.log(`  - ${func} (in unknown location)`);
      }
    });
  } else {
    console.log("\nNo blocking functions found.");
  }
}
