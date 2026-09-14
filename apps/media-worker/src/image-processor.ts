import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Kysely } from "kysely";
import { completeImageJob, failImageJob, type Database } from "@veolms/database";
import { S3StorageService } from "@veolms/storage";
import type { MediaWorkerConfig } from "@veolms/config";
import { RESPONSIVE_IMAGE_WIDTHS } from "./image-variants.ts";

const WEBP_OPTIONS = { quality: 84, effort: 6, smartSubsample: true } as const;

function storageFor(config: MediaWorkerConfig): S3StorageService {
  return new S3StorageService({
    bucket: config.S3_BUCKET,
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  });
}

export async function processImageJob(options: {
  db: Kysely<Database>;
  config: MediaWorkerConfig;
  jobId: string;
  mediaId: string;
  logger?: Pick<Console, "info" | "error">;
}): Promise<void> {
  const started = Date.now();
  const { db, config, jobId, mediaId, logger = console } = options;
  const media = await db.selectFrom("media_assets").selectAll().where("id", "=", mediaId).executeTakeFirst();
  if (!media || media.type !== "image") throw new Error(`Image media ${mediaId} was not found`);
  const scratch = await mkdtemp(join(config.SCRATCH_DIR || tmpdir(), "image-"));
  const sourcePath = join(scratch, "original");
  const storage = storageFor(config);
  try {
    await storage.downloadObject(media.storage_key, sourcePath);
    const source = sharp(sourcePath).rotate();
    const metadata = await source.metadata();
    if (!metadata.width || !metadata.height) throw new Error("Image dimensions are unavailable");
    const processedPrefix = `thumbnails/${mediaId}/processed`;
    const original = { width: metadata.width, height: metadata.height, key: media.storage_key, filename: media.original_filename, mimeType: media.mime_type, sizeBytes: Number(media.size_bytes) };
    const fullBuffer = await source.clone().webp(WEBP_OPTIONS).toBuffer();
    const fullKey = `${processedPrefix}/full.webp`;
    await storage.putObject(fullKey, fullBuffer, "image/webp", fullBuffer.byteLength);
    const full = { width: metadata.width, height: metadata.height, key: fullKey, sizeBytes: fullBuffer.byteLength };
    const variants: Array<{ width: number; height: number; key: string; sizeBytes: number }> = [];
    for (const width of RESPONSIVE_IMAGE_WIDTHS) {
      if (width > metadata.width) continue;
      const buffer = await source.clone().resize({ width, withoutEnlargement: true }).webp(WEBP_OPTIONS).toBuffer();
      const info = await sharp(buffer).metadata();
      const key = `${processedPrefix}/${width}.webp`;
      await storage.putObject(key, buffer, "image/webp", buffer.byteLength);
      variants.push({ width: info.width ?? width, height: info.height ?? Math.round(width * metadata.height / metadata.width), key, sizeBytes: buffer.byteLength });
    }
    await completeImageJob(db, jobId, mediaId, { original, full, variants });
    logger.info({ mediaId, original: `${metadata.width}x${metadata.height}`, variants: variants.map((variant) => variant.width), durationMs: Date.now() - started }, "Image processing completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image processing failed";
    await failImageJob(db, jobId, mediaId, message);
    logger.error({ mediaId, error: message, durationMs: Date.now() - started }, "Image processing failed");
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
