// eslint-plugin-blocking/index.js
module.exports = {
  rules: {
    "no-blocking": {
      create(context) {
        const blockingFunctions = new Set();

        return {
          'CallExpression[callee.object.name="Deno"][callee.property.name=/Sync$/]'(
            node,
          ) {
            let current = node.parent;
            while (current && current.type !== "FunctionDeclaration") {
              current = current.parent;
            }
            if (current?.id?.name) {
              blockingFunctions.add(current.id.name);
            }
          },

          'CallExpression[callee.type="Identifier"]'(node) {
            if (blockingFunctions.has(node.callee.name)) {
              let current = node.parent;
              while (current && current.type !== "FunctionDeclaration") {
                current = current.parent;
              }
              if (current?.id?.name) {
                blockingFunctions.add(current.id.name);
              }
            }
          },

          "FunctionDeclaration[async=true]"(node) {
            if (blockingFunctions.has(node.id?.name)) {
              context.report({
                node,
                message: "Async function contains blocking operations",
              });
            }
          },
        };
      },
    },
  },
};
