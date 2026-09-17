import assert from "node:assert/strict";
import test from "node:test";
import { resolveImageThumbnailPrefix } from "../src/image-processor.ts";

test("uses the flat public thumbnail prefix for public originals", () => {
  assert.equal(
    resolveImageThumbnailPrefix(
      "public/thumbnails/643a2b5c-747d-42d3-9f28-e2d9878d4163/original.png",
      "643a2b5c-747d-42d3-9f28-e2d9878d4163",
    ),
    "public/thumbnails/643a2b5c-747d-42d3-9f28-e2d9878d4163",
  );
});

test("preserves protected visibility for protected originals", () => {
  assert.equal(
    resolveImageThumbnailPrefix(
      "protected/thumbnails/643a2b5c-747d-42d3-9f28-e2d9878d4163/original.jpg",
      "643a2b5c-747d-42d3-9f28-e2d9878d4163",
    ),
    "protected/thumbnails/643a2b5c-747d-42d3-9f28-e2d9878d4163",
  );
});
