import { blocking_c } from "./c.ts";

export async function blocking_b() {
  Deno.readTextFileSync("");
}

export async function wrap_blocking_c() {
  await blocking_c();
}
