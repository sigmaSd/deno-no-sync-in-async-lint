// plugin.ts
import { TypeScriptAnalyzer } from "./analyzer.ts";

const plugin: Deno.lint.Plugin = {
  name: "sync-checker",
  rules: {
    "no-sync-in-async": {
      create(context) {
        const analyzer = new TypeScriptAnalyzer();
        analyzer.analyzeFile(context.filename);
        const state = analyzer.getState();

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
          CallExpression(node: any) {
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
