
import * as ts from "npm:typescript";
import parser from "npm:@typescript-eslint/parser";

const globalState = {
  blockingFunctions: new Set<string>(),
  importMap: new Map<string, { source: string; name: string }>(),
  analyzedFiles: new Map<string, Set<string>>(),
  analyzedPaths: new Set<string>(),
  functionCalls: new Map<string, Set<string>>(),
};

function normalizeImportPath(importSpecifier: string, currentFile: string): string {
  const ensureAbsolute = (path: string) =>
    path.startsWith('/') ? path : `/${path}`;

  if (!importSpecifier.startsWith('.')) {
    return importSpecifier;
  }

  const currentDir = currentFile.replace(/\/[^/]+$/, '');

  try {
    const url = new URL(importSpecifier, `file://${ensureAbsolute(currentDir)}/`);
    const resolved = decodeURIComponent(url.pathname);
    return resolved.endsWith('.ts') ? resolved : `${resolved}.ts`;
  } catch (error) {
    console.error(`Error normalizing path ${importSpecifier} relative to ${currentDir}:`, error);
    return importSpecifier;
  }
}

function resolveImportPath(importSpecifier: string, currentFile: string): string {
  console.log(`\nResolving import:
  From file: ${currentFile}
  Import specifier: ${importSpecifier}
  Working directory: ${Deno.cwd()}`);

  try {
    const resolved = normalizeImportPath(importSpecifier, currentFile);
    console.log(`Resolved to: ${resolved}`);

    try {
      Deno.statSync(resolved);
      console.log(`File exists: ${resolved}`);
    } catch (error) {
      console.warn(`Warning: Resolved file does not exist: ${resolved}`);
    }

    return resolved;
  } catch (error) {
    console.error(`Error resolving import:`, error);
    return importSpecifier;
  }
}

function findBlockingFunctionsInTypescript(sourceFile: ts.SourceFile): Set<string> {
  const blockingFuncs = new Set<string>();
  let currentFunction: string | undefined;

  function visit(node: ts.Node) {
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
          console.log(`Found Deno.*Sync in function: ${currentFunction}`);
          blockingFuncs.add(currentFunction);
          globalState.blockingFunctions.add(currentFunction);
        }
      } else if (ts.isIdentifier(expr) && currentFunction) {
        const calledName = expr.text;
        globalState.functionCalls.get(currentFunction)?.add(calledName);
        console.log(`Recording function call: ${currentFunction} calls ${calledName}`);
      }
    }

    node.forEachChild(visit);

    if (ts.isFunctionDeclaration(node) && node.name) {
      currentFunction = undefined;
    }
  }

  visit(sourceFile);
  return blockingFuncs;
}

function propagateBlockingStatus(): void {
  let changed = true;
  while (changed) {
    changed = false;

    // First pass: check direct blocking functions
    for (const [caller, callees] of globalState.functionCalls) {
      if (!globalState.blockingFunctions.has(caller)) {
        for (const callee of callees) {
          // Direct blocking check
          if (globalState.blockingFunctions.has(callee)) {
            console.log(`Marking ${caller} as blocking (calls blocking function ${callee})`);
            globalState.blockingFunctions.add(caller);
            changed = true;
            break;
          }
        }
      }
    }

    // Second pass: check imported functions
    for (const [localName, importInfo] of globalState.importMap) {
      const sourceBlockingFuncs = globalState.analyzedFiles.get(importInfo.source);
      if (sourceBlockingFuncs?.has(importInfo.name)) {
        if (!globalState.blockingFunctions.has(localName)) {
          console.log(`Marking imported function ${localName} as blocking (from ${importInfo.source})`);
          globalState.blockingFunctions.add(localName);
          changed = true;
        }
      }
    }

    // Third pass: check function calls that use imported functions
    for (const [caller, callees] of globalState.functionCalls) {
      if (!globalState.blockingFunctions.has(caller)) {
        for (const callee of callees) {
          const importInfo = globalState.importMap.get(callee);
          if (importInfo) {
            const sourceBlockingFuncs = globalState.analyzedFiles.get(importInfo.source);
            if (sourceBlockingFuncs?.has(importInfo.name)) {
              console.log(`Marking ${caller} as blocking (calls imported blocking function ${callee})`);
              globalState.blockingFunctions.add(caller);
              changed = true;
              break;
            }
          }
        }
      }
    }
  }
}

async function analyzeFileAndImports(filePath: string, visited = new Set<string>()): Promise<Set<string>> {
  const absolutePath = filePath.startsWith('/') ? filePath : `${Deno.cwd()}/${filePath}`;
  const normalizedPath = normalizeImportPath(absolutePath, Deno.cwd());

  if (visited.has(normalizedPath)) {
    return globalState.analyzedFiles.get(normalizedPath) || new Set();
  }

  visited.add(normalizedPath);
  console.log(`\nAnalyzing file: ${normalizedPath}`);

  try {
    const content = Deno.readTextFileSync(normalizedPath);
    const sourceFile = ts.createSourceFile(
      normalizedPath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    // First collect all imports
    const imports = new Map<string, string>();
    sourceFile.forEachChild(node => {
      if (ts.isImportDeclaration(node)) {
        const source = node.moduleSpecifier.getText().replace(/['"]/g, '');
        if (source.startsWith('.')) {
          const importPath = resolveImportPath(source, normalizedPath);

          node.importClause?.namedBindings?.forEachChild(specifier => {
            if (ts.isImportSpecifier(specifier)) {
              const localName = specifier.name.text;
              const importedName = (specifier.propertyName || specifier.name).text;
              imports.set(localName, importPath);
              globalState.importMap.set(localName, {
                source: importPath,
                name: importedName
              });
            }
          });
        }
      }
    });

    // Analyze all imported files first
    for (const [_, importPath] of imports) {
      if (!visited.has(importPath)) {
        await analyzeFileAndImports(importPath, visited);
      }
    }

    // Then analyze the current file
    const blockingFuncs = findBlockingFunctionsInTypescript(sourceFile);
    globalState.analyzedFiles.set(normalizedPath, blockingFuncs);

    for (const func of blockingFuncs) {
      globalState.blockingFunctions.add(func);
    }

    propagateBlockingStatus();
    return blockingFuncs;
  } catch (error) {
    console.error(`Error analyzing ${normalizedPath}:`, error);
    return new Set();
  }
}

function isBlockingFunction(name: string, visited = new Set<string>()): boolean {
  if (visited.has(name)) return false;
  visited.add(name);

  if (globalState.blockingFunctions.has(name)) {
    return true;
  }

  const importInfo = globalState.importMap.get(name);
  if (importInfo) {
    if (globalState.blockingFunctions.has(importInfo.name)) {
      globalState.blockingFunctions.add(name);
      return true;
    }

    const sourceBlockingFuncs = globalState.analyzedFiles.get(importInfo.source);
    if (sourceBlockingFuncs?.has(importInfo.name)) {
      globalState.blockingFunctions.add(name);
      return true;
    }
  }

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

function analyzeDenoSyncCalls(filePath: string): Set<string> {
  return analyzeFileAndImports(filePath);
}


const noAsyncSyncRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow synchronous operations in async functions",
      category: "Best Practices",
      recommended: true,
    },
    schema: [],
  },
  create(context) {
    let analyzed = false;
    let analysisPromise: Promise<void> | null = null;

    async function analyzeFile() {
      if (analyzed) return;

      globalState.blockingFunctions.clear();
      console.log("\nAnalyzing file:", context.filename);

      await analyzeDenoSyncCalls(context.filename);
      propagateBlockingStatus();
      analyzed = true;

      console.log("\nAnalysis complete. Blocking functions:", Array.from(globalState.blockingFunctions));
    }

    return {
      Program(node) {
        if (!analyzed && !analysisPromise) {
          analysisPromise = analyzeFile();
        }
      },

      async "Program:exit"() {
        if (analysisPromise) {
          await analysisPromise;
        }

        const sourceFile = context.getSourceCode();
        for (const node of sourceFile.ast.body) {
          if (
            node.type === "FunctionDeclaration" &&
            node.async &&
            node.id?.name
          ) {
            const funcName = node.id.name;
            if (isBlockingFunction(funcName, new Set())) {
              const blockingChain = findBlockingChain(funcName);
              context.report({
                node,
                message: `Async function '${funcName}' contains blocking operations through: ${blockingChain.join(" -> ")}`,
              });
            }
          }
        }

        console.log("\nFinal Analysis Summary:");
        console.log("All blocking functions:", Array.from(globalState.blockingFunctions));
        console.log(
          "Analyzed files:",
          Object.fromEntries(
            Array.from(globalState.analyzedFiles.entries())
              .map(([k, v]) => [k, Array.from(v)])
          )
        );
      }
    };
  }
};

// Add this helper function to trace the blocking chain
function findBlockingChain(funcName: string, visited = new Set<string>()): string[] {
  if (visited.has(funcName)) return [];
  visited.add(funcName);

  // Check direct Deno.*Sync usage
  const fileEntries = Array.from(globalState.analyzedFiles.entries());
  for (const [file, funcs] of fileEntries) {
    if (funcs.has(funcName)) {
      return [funcName];
    }
  }

  // Check imported functions
  const importInfo = globalState.importMap.get(funcName);
  if (importInfo) {
    const sourceBlockingFuncs = globalState.analyzedFiles.get(importInfo.source);
    if (sourceBlockingFuncs?.has(importInfo.name)) {
      return [funcName, importInfo.name];
    }
  }

  // Check function calls
  const calls = globalState.functionCalls.get(funcName);
  if (calls) {
    for (const callee of calls) {
      if (!visited.has(callee)) {
        const chain = findBlockingChain(callee, visited);
        if (chain.length > 0) {
          return [funcName, ...chain];
        }
      }
    }
  }

  return [];
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
          "no-async-sync": noAsyncSyncRule
        }
      }
    },
    rules: {
      "custom/no-async-sync": "error"
    }
  }
];
