import { blocking_b, wrap_blocking_c } from "./b.ts";

export async function blocking() {
  Deno.writeTextFileSync("hello.txt", "world");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

export async function blocking2() {
  await blocking();
}

export async function blocking_wrap_b() {
  await blocking_b();
}

export async function blocking_wrap_b_c() {
  await wrap_blocking_c();
}

export async function not_blocking() {
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
