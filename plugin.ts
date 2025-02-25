/**
 * @module no-sync-in-async/plugin
 * @description A Deno lint plugin that detects synchronous operations within async functions.
 * This includes:
 * - Calls to Deno.*Sync methods
 * - Calls to known blocking functions
 * - Method calls to known blocking functions
 *
 * The plugin analyzes TypeScript/JavaScript files to identify potentially problematic
 * synchronous operations that could block the event loop when used in async contexts.
 *
 * @example
 * // Invalid examples - these will trigger lint errors:
 *
 * async function readFile() {
 *   // Error: Sync operation readFileSync found in async function readFile
 *   const content = Deno.readFileSync("file.txt");
 * }
 *
 * async function processData() {
 *   // Error: Blocking function 'readFile' called in async function 'processData'
 *   readFile();
 * }
 *
 * // Valid examples - these are fine:
 *
 * // Synchronous functions using sync operations
 * function normalFunction() {
 *   const content = Deno.readFileSync("file.txt"); // OK
 * }
 *
 * // Async functions using async operations
 * async function goodExample() {
 *   const content = await Deno.readFile("file.txt"); // OK
 *   const data = await asyncOperation(); // OK
 * }
 *
 * @example
 * // Configuration in deno.json:
 * {
 *   "lint": {
 *     "plugins": [
 *        "jsr:@sigmasd/deno-no-sync-in-async-lint@0.5.0"
 *      ]
 *   }
 * }
 */

import { TypeScriptAnalyzer } from "./analyzer.ts";

/**
 * A Deno lint plugin that detects synchronous operations within async functions.
 * The plugin analyzes code for potentially blocking operations that could affect performance.
 */
const plugin: Deno.lint.Plugin = {
  name: "sync-checker",
  rules: {
    "no-sync-in-async": {
      create(context) {
        const analyzer = new TypeScriptAnalyzer();
        analyzer.analyzeFile(context.filename);
        const state = analyzer.getState();

        // TODO: report upstream type issues
        // deno-lint-ignore no-explicit-any
        function findAsyncParent(node: any): string | undefined {
          let current = node;
          while (current) {
            if (current.type === "FunctionDeclaration" && current.async) {
              return current.id?.name;
            }
            if (current.type === "ArrowFunctionExpression" && current.async) {
              if (current.parent?.type === "VariableDeclarator") {
                return current.parent.id?.name;
              }
              if (current.parent?.type === "PropertyDefinition") {
                return current.parent.key?.name;
              }
              if (current.parent?.type === "MethodDefinition") {
                return current.parent.key?.name;
              }
            }
            if (
              current.type === "MethodDefinition" &&
              current.value?.async &&
              current.key?.name
            ) {
              return current.key.name;
            }
            if (
              current.type === "PropertyDefinition" &&
              current.value?.type === "ArrowFunctionExpression" &&
              current.value.async &&
              current.key?.name
            ) {
              return current.key.name;
            }
            current = current.parent;
          }
          return undefined;
        }

        return {
          CallExpression(node: Deno.lint.CallExpression) {
            const asyncFuncName = findAsyncParent(node);
            if (!asyncFuncName) return;

            // Check for Deno.*Sync calls
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
                  `Sync operation ${node.callee.property.name} found in async function ${asyncFuncName}`,
                fix(fixer) {
                  const syncName = ((node.callee as Deno.lint.MemberExpression)
                    .property as Deno.lint.PrivateIdentifier)
                    .name;
                  // deno-fmt-ignore
                  const nodeArgs = node.arguments.map(arg => (arg as Deno.lint.Literal).raw).join(", ");
                  // deno-fmt-ignore
                  const asyncName = `await Deno.${syncName.replace("Sync", "")}(${nodeArgs})`;
                  return fixer.replaceText(node, asyncName);
                },
              });
              return;
            }

            // Check for direct calls to known blocking functions
            if (
              node.callee.type === "Identifier" &&
              state.blockingFunctions.has(node.callee.name)
            ) {
              const loc = state.functionLocations.get(node.callee.name);
              context.report({
                node,
                message:
                  `Blocking function '${node.callee.name}' called in async function '${asyncFuncName}'${
                    loc
                      ? ` (defined at ${loc.file}:${loc.line}:${loc.column})`
                      : ""
                  }`,
              });
            }

            // Check for method calls to known blocking functions
            if (
              node.callee.type === "MemberExpression" &&
              node.callee.property.type === "Identifier" &&
              state.blockingFunctions.has(node.callee.property.name)
            ) {
              const loc = state.functionLocations.get(
                node.callee.property.name,
              );
              context.report({
                node,
                message:
                  `Blocking method '${node.callee.property.name}' called in async function '${asyncFuncName}'${
                    loc
                      ? ` (defined at ${loc.file}:${loc.line}:${loc.column})`
                      : ""
                  }`,
              });
            }
          },
        };
      },
    },
  },
};

export default plugin;
