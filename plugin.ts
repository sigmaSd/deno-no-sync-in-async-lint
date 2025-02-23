// plugin.ts
import { TypeScriptAnalyzer } from "./analyzer.ts";

const plugin: Deno.lint.Plugin = {
  name: "sync-checker",
  rules: {
    "no-sync-in-async": {
      create(context) {
        const analyzer = new TypeScriptAnalyzer();
        analyzer.analyzeFileSync(context.filename);
        const blockingFunctions = analyzer.getState().blockingFunctions;

        return {
          CallExpression(node) {
            // Find containing async function
            // @ts-ignore parent exists
            let parent = node.parent;
            let asyncFunction = null;
            while (parent) {
              if (
                parent.type === "FunctionDeclaration" &&
                (parent as any).async
              ) {
                asyncFunction = parent;
                break;
              }
              parent = parent.parent;
            }

            if (!asyncFunction) return;

            const funcName = (asyncFunction as any).id?.name;
            if (!funcName) return;

            console.log(`Checking call in async function ${funcName}`);

            // Check for Deno.*Sync calls
            if (
              node.callee.type === "MemberExpression" &&
              node.callee.object.type === "Identifier" &&
              node.callee.object.name === "Deno" &&
              node.callee.property.type === "Identifier" &&
              node.callee.property.name.endsWith("Sync")
            ) {
              console.log(
                `Found Deno.${node.callee.property.name} in ${funcName}`,
              );
              context.report({
                node,
                message:
                  `Sync operation ${node.callee.property.name} found in async function ${funcName}`,
                fix(fixer) {
                  // @ts-ignore property exists
                  const syncName = node.callee.property.name;
                  const asyncName = `await Deno.${
                    syncName.replace("Sync", "")
                  }`;
                  return fixer.replaceText(node.callee, asyncName);
                },
              });
              return;
            }

            // Check for blocking function calls
            if (node.callee.type === "Identifier") {
              const calleeName = node.callee.name;
              if (blockingFunctions.has(calleeName)) {
                console.log(
                  `Found blocking call to ${calleeName} in ${funcName}`,
                );
                context.report({
                  node,
                  message:
                    `Blocking function '${calleeName}' called in async function '${funcName}'`,
                });
              }
            }
          },
        };
      },
    },
  },
};

export default plugin;
