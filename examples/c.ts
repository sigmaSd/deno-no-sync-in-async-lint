export async function blocking_c() {
  Deno.readTextFileSync("");
  await Promise.resolve();
}
