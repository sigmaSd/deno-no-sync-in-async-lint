// plugins/plugin.ts
import { Analyzer } from "./analyzer.ts";

const analyzer = new Analyzer();

export default {
  name: "my-lint-plugin",
  rules: {
    "my-lint-rule": {
      create(context) {
        return {
          Program(node) {
            // Mark imported blocking functions from b.ts
            if (context.filename.endsWith("b.ts")) {
              analyzer.addBlockingFunction("blocking_b");
            }
            analyzer.analyzeFile(context.filename, node);
          },
          "FunctionDeclaration, ExportNamedDeclaration > FunctionDeclaration"(
            node,
          ) {
            if (node.async && node.id?.name) {
              const funcName = node.id.name;
              console.log(`\nChecking async function: ${funcName}`);
              if (analyzer.isBlocking(funcName)) {
                console.log(`!! Reporting ${funcName} as blocking`);
                context.report({
                  node,
                  message: "Async function contains blocking operations",
                });
              }
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
