import { blocking_b } from "./b.ts";

export async function blocking() {
  Deno.readTextFileSync("");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

export async function blocking2() {
  await blocking();
}

export async function blocking_wrap_b() {
  await blocking_b();
}

export async function not_blocking() {
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
