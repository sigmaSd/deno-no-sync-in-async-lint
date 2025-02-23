import { TypeScriptAnalyzer } from "./analyzer.ts";

const plugin: Deno.lint.Plugin = {
  name: "sync-checker",
  rules: {
    "no-sync-in-async": {
      create(context) {
        const analyzer = new TypeScriptAnalyzer();
        let analyzed = false;

        return {
          Program() {
            if (!analyzed) {
              analyzer.analyzeFile(context.filename);
              analyzed = true;
            }
          },

          "CallExpression"(node) {
            // Check if we're inside an async function
            // @ts-ignore parent does exist
            let parent = node.parent;
            while (parent && parent.type !== "FunctionDeclaration") {
              parent = parent.parent;
            }

            if (parent?.type === "FunctionDeclaration" && parent.async) {
              const funcName = parent.id?.name;
              if (funcName && analyzer.isBlockingFunction(funcName)) {
                // Check if this call is a blocking operation
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
                      `Blocking operation found in async function '${funcName}'`,
                    fix(fixer) {
                      const syncName =
                        ((node.callee as Deno.lint.MemberExpression)
                          .property as Deno.lint.PrivateIdentifier).name;
                      // deno-fmt-ignore
                      const asyncName = `await Deno.${syncName.replace("Sync", "")}`;
                      return fixer.replaceText(node.callee, asyncName);
                    },
                  });
                } else if (
                  node.callee.type === "Identifier" &&
                  analyzer.isBlockingFunction(node.callee.name)
                ) {
                  context.report({
                    node,
                    message:
                      `Blocking operation found in async function '${funcName}'`,
                  });
                }
              }
            }
          },
        };
      },
    },
  },
};

export default plugin;
