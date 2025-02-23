export default {
  name: "my-lint-plugin",
  rules: {
    "my-lint-rule": {
      create(context) {
        const blockingFunctions = new Set<string>();

        return {
          // Track imported blocking functions
          ImportSpecifier(node) {
            if (node.imported.name.includes("blocking")) { // This is a simple heuristic
              blockingFunctions.add(node.local.name);
            }
          },

          MemberExpression(node) {
            if (
              node.object.name === "Deno" && node.property.name.endsWith("Sync")
            ) {
              let current = node;
              while (current.parent) {
                if (current.parent.type === "FunctionDeclaration") {
                  if (current.parent.id?.name) {
                    blockingFunctions.add(current.parent.id.name);
                    if (current.parent.async) {
                      context.report({
                        node: node,
                        message: `Async function contains blocking Sync call`,
                      });
                    }
                  }
                }
                current = current.parent;
              }
            }
          },

          CallExpression(node) {
            if (
              node.callee.type === "Identifier" &&
              (blockingFunctions.has(node.callee.name) ||
                node.callee.name.includes("blocking")) // This is a simple heuristic
            ) {
              let current = node;
              while (current.parent) {
                if (current.parent.type === "FunctionDeclaration") {
                  if (current.parent.id?.name) {
                    blockingFunctions.add(current.parent.id.name);
                    if (current.parent.async) {
                      context.report({
                        node,
                        message:
                          `Function calls blocking function "${node.callee.name}"`,
                      });
                    }
                  }
                }
                current = current.parent;
              }
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
