import { assertEquals } from "jsr:@std/assert@1.0.11";
import Plugin from "./plugin.ts";

Deno.test("no-sync-in-async", () => {
  const diagnostics = Deno.lint.runPlugin(
    Plugin,
    "main.ts",
    `
    export async function blocking() {
      Deno.writeTextFileSync("hello.txt", "world");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // NOTE: This is not detected because the plugin requires read permission to work correctly
    // If you run deno lint from the cli and give the needed permissions it does lint it correctly
    export async function blocking2() {
      await blocking();
    }

    export async function not_blocking() {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    `,
  );

  assertEquals(diagnostics.length, 1);
  const d = diagnostics[0];
  assertEquals(d.id, "sync-checker/no-sync-in-async");
  assertEquals(
    d.message,
    "Sync operation writeTextFileSync found in async function blocking",
  );
  assertEquals(
    // @ts-ignore TODO: remove in 2.2.2
    d.fix?.at(0).text,
    'await Deno.writeTextFile("hello.txt", "world")',
  );
});
