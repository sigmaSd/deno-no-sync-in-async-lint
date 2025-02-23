// plugins/analyzer.ts
export class Analyzer {
  private blockingFunctions = new Set<string>();
  private importedBlockingFunctions = new Map<string, string>(); // local => original

  analyzeFile(filePath: string, ast: any): void {
    console.log("\n=== Analyzing file:", filePath, "===");

    // Handle imports first
    for (const node of ast.body) {
      if (node.type === "ImportDeclaration") {
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            console.log(
              `Found import: ${specifier.local.name} from ${specifier.imported.name}`,
            );
            this.importedBlockingFunctions.set(
              specifier.local.name,
              specifier.imported.name,
            );
          }
        }
      }
    }

    // Then analyze the rest
    this.analyzeNode(ast);

    console.log("\nBlocking functions:", Array.from(this.blockingFunctions));
    console.log(
      "Imported blocking functions:",
      Object.fromEntries(this.importedBlockingFunctions),
    );
  }

  private analyzeNode(node: any): void {
    if (!node || typeof node !== "object") return;

    // Handle export declarations
    if (node.type === "ExportNamedDeclaration" && node.declaration) {
      console.log("Processing export declaration");
      this.analyzeNode(node.declaration);
      return;
    }

    // Check for function declarations
    if (node.type === "FunctionDeclaration" && node.id?.name) {
      const funcName = node.id.name;
      console.log("\n-> Analyzing function:", funcName);

      // Check the function body for blocking operations
      if (node.body && node.body.type === "BlockStatement") {
        for (const statement of node.body.body) {
          console.log("  Checking statement:", statement.type);

          if (this.isBlockingStatement(statement)) {
            console.log(`  !! Found blocking operation in ${funcName}`);
            this.blockingFunctions.add(funcName);
            break;
          }
        }
      }
    }

    // Recurse into body
    if (node.body) {
      if (Array.isArray(node.body)) {
        node.body.forEach((child: any) => this.analyzeNode(child));
      } else {
        this.analyzeNode(node.body);
      }
    }
  }

  private isBlockingStatement(node: any): boolean {
    // Check for Deno.*Sync calls
    if (
      node.type === "ExpressionStatement" &&
      node.expression.type === "CallExpression" &&
      node.expression.callee?.type === "MemberExpression" &&
      node.expression.callee.object?.name === "Deno" &&
      node.expression.callee.property?.name?.endsWith("Sync")
    ) {
      console.log("    Found Deno.*Sync call");
      return true;
    }

    // Check for calls to known blocking functions
    if (
      node.type === "ExpressionStatement" &&
      node.expression.type === "CallExpression" &&
      node.expression.callee?.type === "Identifier"
    ) {
      const calledFunc = node.expression.callee.name;
      // Check both direct and imported blocking functions
      if (this.blockingFunctions.has(calledFunc)) {
        console.log(`    Found call to blocking function: ${calledFunc}`);
        return true;
      }
      if (this.importedBlockingFunctions.has(calledFunc)) {
        console.log(
          `    Found call to imported blocking function: ${calledFunc}`,
        );
        return true;
      }
    }

    // Check await expressions
    if (
      node.type === "ExpressionStatement" &&
      node.expression.type === "AwaitExpression"
    ) {
      return this.isBlockingExpression(node.expression.argument);
    }

    return false;
  }

  private isBlockingExpression(expr: any): boolean {
    if (!expr) return false;

    // Direct blocking call
    if (
      expr.type === "CallExpression" &&
      expr.callee?.type === "MemberExpression" &&
      expr.callee.object?.name === "Deno" &&
      expr.callee.property?.name?.endsWith("Sync")
    ) {
      return true;
    }

    // Call to blocking function
    if (
      expr.type === "CallExpression" &&
      expr.callee?.type === "Identifier"
    ) {
      const calledFunc = expr.callee.name;
      return this.blockingFunctions.has(calledFunc) ||
        this.importedBlockingFunctions.has(calledFunc);
    }

    return false;
  }

  isBlocking(functionName: string): boolean {
    const result = this.blockingFunctions.has(functionName) ||
      this.importedBlockingFunctions.has(functionName);
    console.log(`Checking if ${functionName} is blocking:`, result);
    return result;
  }

  addBlockingFunction(name: string) {
    this.blockingFunctions.add(name);
  }
}
