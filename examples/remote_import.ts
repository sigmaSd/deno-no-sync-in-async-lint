import { withTempDir } from "jsr:@sigmasd/jsr-test@0.0.6";

export async function b() {
  await withTempDir(() => {});
}
