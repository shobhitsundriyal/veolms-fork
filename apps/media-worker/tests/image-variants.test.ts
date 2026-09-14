import assert from "node:assert/strict";
import test from "node:test";
import { selectResponsiveWidths } from "../src/image-variants.ts";

test("does not advertise widths larger than the source", () => {
  assert.deepEqual(selectResponsiveWidths(1000), [160, 240, 320, 480, 640, 960]);
  assert.deepEqual(selectResponsiveWidths(1280), [160, 240, 320, 480, 640, 960, 1280]);
  assert.deepEqual(selectResponsiveWidths(120), []);
});
