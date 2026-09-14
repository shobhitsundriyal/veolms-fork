import { run } from "./index.ts";

// Local development needs a continuously running image worker so uploads made
// through the course editor can reach the processed CDN state without requiring
// a second manual command. Production/video workers keep their existing mode.
process.env.IMAGE_WORKER_MODE = "true";

run().catch((error) => {
  console.error("[media-worker] Development image worker failed:", error);
  process.exitCode = 1;
});
