import ts from "npm:typescript@5.7.2";
import * as path from "jsr:@std/path@1.0.8";

interface RemoteModuleInfo {
  url: string;
  content?: string;
  blockingFunctions: Set<string>;
}

interface FunctionLocation {
  file: string;
  line: number;
  column: number;
}

export interface AnalyzerState {
  blockingFunctions: Set<string>;
  importMap: Map<string, { source: string; name: string }>;
  analyzedFiles: Map<string, Set<string>>;
  functionCalls: Map<string, Set<string>>;
  remoteModules: Map<string, RemoteModuleInfo>;
  functionLocations: Map<string, FunctionLocation>;
}

export class TypeScriptAnalyzer {
  private state: AnalyzerState = {
    blockingFunctions: new Set<string>(),
    importMap: new Map<string, { source: string; name: string }>(),
    analyzedFiles: new Map<string, Set<string>>(),
    functionCalls: new Map<string, Set<string>>(),
    remoteModules: new Map(),
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

    // Mark all functions that call this function as blocking
    for (const [caller, callees] of this.state.functionCalls.entries()) {
      if (callees.has(funcName)) {
        this.markAsBlocking(caller, visited);
        // If the caller doesn't have a location, inherit from the callee
        if (!this.state.functionLocations.has(caller)) {
          const location = this.state.functionLocations.get(funcName);
          if (location) {
            this.state.functionLocations.set(caller, location);
          }
        }
      }
    }
  }
  private async resolveJsrUrl(jsrSpecifier: string): Promise<string> {
    try {
      const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
      await Deno.writeTextFile(
        tempFile,
        `import {} from "${jsrSpecifier}";`,
      );

      const command = new Deno.Command("deno", {
        args: ["info", tempFile, "--json"],
      });
      const output = await command.output();
      await Deno.remove(tempFile);

      const info = JSON.parse(new TextDecoder().decode(output.stdout));
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

          if (source.startsWith("npm:")) {
            console.warn(
              `Warning: npm: specifiers are not yet supported for analysis: ${source}`,
            );
            return;
          }

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
                          this.state.functionLocations.set(localName, {
                            file: source,
                            line: 1,
                            column: 1,
                          });
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

  private fetchSync(url: string): string {
    const command = new Deno.Command("curl", {
      args: ["-s", url],
    });
    const output = command.outputSync();
    if (output.success) {
      return new TextDecoder().decode(output.stdout);
    }
    throw new Error(
      `Failed to fetch ${url}: ${new TextDecoder().decode(output.stderr)}`,
    );
  }

  private resolveJsrUrlSync(jsrSpecifier: string): string {
    try {
      const tempFile = Deno.makeTempFileSync({ suffix: ".ts" });
      Deno.writeTextFileSync(
        tempFile,
        `import {} from "${jsrSpecifier}";`,
      );

      const command = new Deno.Command("deno", {
        args: ["info", tempFile, "--json"],
      });
      const output = command.outputSync();
      Deno.removeSync(tempFile);

      const info = JSON.parse(new TextDecoder().decode(output.stdout));
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

  private fetchAndAnalyzeRemoteModuleSync(url: string): Set<string> {
    if (this.state.remoteModules.has(url)) {
      return this.state.remoteModules.get(url)!.blockingFunctions;
    }

    try {
      const actualUrl = url.startsWith("jsr:")
        ? this.resolveJsrUrlSync(url)
        : url;

      console.log(`Fetching module from ${actualUrl}`);
      const content = this.fetchSync(actualUrl);

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
  analyzeFileSync(filePath: string, visited = new Set<string>()): Set<string> {
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
          if (source.startsWith("npm:")) {
            console.warn(
              `Warning: npm: specifiers are not yet supported for analysis: ${source}`,
            );
            return;
          }

          if (source.startsWith("jsr:") || source.startsWith("npm:")) {
            const blockingFuncs = this.fetchAndAnalyzeRemoteModuleSync(source);
            if (node.importClause?.namedBindings) {
              if (ts.isNamedImports(node.importClause.namedBindings)) {
                node.importClause.namedBindings.elements.forEach((element) => {
                  const localName = element.name.text;
                  const importedName = element.propertyName?.text ||
                    element.name.text;
                  this.state.importMap.set(localName, {
                    source,
                    name: importedName,
                  });
                  if (blockingFuncs.has(importedName)) {
                    this.markAsBlocking(localName);
                    this.state.functionLocations.set(localName, {
                      file: source,
                      line: 1,
                      column: 1,
                    });
                  }
                });
              }
            }
          } else if (source.startsWith(".")) {
            const importPath = this.normalizeImportPath(source, absolutePath);
            this.analyzeFileSync(importPath, visited);
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
      console.error(`Error analyzing ${absolutePath}:`, error);
      return new Set();
    }
  }
}

if (import.meta.main) {
  const analyzer = new TypeScriptAnalyzer();
  const filePath = Deno.args[0];
  if (!filePath) {
    console.error("Please provide a file path to analyze");
    Deno.exit(1);
  }

  analyzer.analyzeFileSync(filePath);
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
