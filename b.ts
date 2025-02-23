export async function blocking_b() {
  Deno.readTextFileSync("");
}
