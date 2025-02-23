import ts from "npm:typescript@5.7.2";
import * as path from "jsr:@std/path@1.0.8";

interface RemoteModuleInfo {
  url: string;
  content?: string;
  blockingFunctions: Set<string>;
}

export interface AnalyzerState {
  blockingFunctions: Set<string>;
  importMap: Map<string, { source: string; name: string }>;
  analyzedFiles: Map<string, Set<string>>;
  functionCalls: Map<string, Set<string>>;
  remoteModules: Map<string, RemoteModuleInfo>;
}

export class TypeScriptAnalyzer {
  private state: AnalyzerState = {
    blockingFunctions: new Set<string>(),
    importMap: new Map<string, { source: string; name: string }>(),
    analyzedFiles: new Map<string, Set<string>>(),
    functionCalls: new Map<string, Set<string>>(),
    remoteModules: new Map(),
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

  private async resolveJsrUrl(jsrSpecifier: string): Promise<string> {
    try {
      // Create a temporary file to use with deno info
      const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
      await Deno.writeTextFile(
        tempFile,
        `import {} from "${jsrSpecifier}";`,
      );

      // Run deno info and capture the output
      const command = new Deno.Command("deno", {
        args: ["info", tempFile, "--json"],
      });
      const output = await command.output();
      await Deno.remove(tempFile);

      // Parse the JSON output
      const info = JSON.parse(new TextDecoder().decode(output.stdout));

      // Find the URL corresponding to the JSR module
      const url = info.redirects[jsrSpecifier];
      if (url) {
        return url;
      }
      throw new Error(`Could not resolve JSR URL for ${jsrSpecifier}`);
    } catch (error) {
      console.error(`Error resolving JSR URL for ${jsrSpecifier}:`, error);
      throw error;
    }
  }

  private async fetchAndAnalyzeRemoteModule(url: string): Promise<Set<string>> {
    if (this.state.remoteModules.has(url)) {
      return this.state.remoteModules.get(url)!.blockingFunctions;
    }

    try {
      // Resolve JSR URLs to their actual URLs
      const actualUrl = url.startsWith("jsr:")
        ? await this.resolveJsrUrl(url)
        : url;

      console.log(`Fetching module from ${actualUrl}`);
      const response = await fetch(actualUrl);
      const content = await response.text();

      const moduleInfo: RemoteModuleInfo = {
        url,
        content,
        blockingFunctions: new Set<string>(),
      };

      this.state.remoteModules.set(url, moduleInfo);

      const sourceFile = ts.createSourceFile(
        url,
        content,
        ts.ScriptTarget.Latest,
        true,
      );

      const blockingFuncs = this.analyzeSourceFile(sourceFile, url, new Set());
      moduleInfo.blockingFunctions = blockingFuncs;
      return blockingFuncs;
    } catch (error) {
      console.error(`Error fetching remote module ${url}:`, error);
      return new Set();
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

  async analyzeFile(filePath: string, visited = new Set<string>()) {
    const absolutePath = path.resolve(filePath);

    if (visited.has(absolutePath)) {
      return this.state.analyzedFiles.get(absolutePath) || new Set();
    }

    visited.add(absolutePath);

    try {
      const content = await Deno.readTextFile(absolutePath);
      const sourceFile = ts.createSourceFile(
        absolutePath,
        content,
        ts.ScriptTarget.Latest,
        true,
      );

      // First pass: collect and analyze imports
      const importPromises: Promise<void>[] = [];

      const analyzeImports = (node: ts.Node) => {
        if (ts.isImportDeclaration(node)) {
          const source = node.moduleSpecifier.getText().replace(/['"]/g, "");

          if (source.startsWith("jsr:") || source.startsWith("npm:")) {
            // Handle remote imports
            importPromises.push(
              this.fetchAndAnalyzeRemoteModule(source).then((blockingFuncs) => {
                if (node.importClause?.namedBindings) {
                  if (ts.isNamedImports(node.importClause.namedBindings)) {
                    node.importClause.namedBindings.elements.forEach(
                      (element) => {
                        const localName = element.name.text;
                        const importedName = element.propertyName?.text ||
                          element.name.text;
                        this.state.importMap.set(localName, {
                          source,
                          name: importedName,
                        });
                        if (blockingFuncs.has(importedName)) {
                          this.markAsBlocking(localName);
                        }
                      },
                    );
                  }
                }
              }),
            );
          } else if (source.startsWith(".")) {
            const importPath = this.normalizeImportPath(source, absolutePath);
            importPromises.push(this.analyzeFile(importPath, visited).then());
          }
        }
      };

      ts.forEachChild(sourceFile, analyzeImports);

      // Wait for all imports to be analyzed
      await Promise.all(importPromises);

      const blockingFuncs = this.analyzeSourceFile(
        sourceFile,
        absolutePath,
        visited,
      );
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

  await analyzer.analyzeFile(filePath);

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

  console.log("\nRemote modules analyzed:");
  for (const [url, info] of analyzer.getState().remoteModules) {
    console.log(
      `  ${url} - Blocking functions: [${
        [...info.blockingFunctions].sort().join(", ")
      }]`,
    );
  }
}
