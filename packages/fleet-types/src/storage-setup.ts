import type { Interface as ReadlineInterface } from "node:readline/promises";
import {
  ask,
  askChoice,
  bold,
  cyan,
  dim,
  green,
  isNonInteractive,
  ok,
} from "./terminal.ts";

export interface StoragePromptOptions {
  readonly rl?: ReadlineInterface;
  readonly provider: "local" | "docker" | "aws";
  readonly existingEnv?: Readonly<Record<string, string | undefined>>;
  readonly nonInteractive?: boolean;
}

export interface StoragePromptResult {
  readonly storageProvider: "local" | "s3";
  readonly useIamRole?: boolean;
  readonly s3Bucket?: string;
  readonly s3Endpoint?: string;
  readonly s3Region?: string;
  readonly s3AccessKeyId?: string;
  readonly s3SecretAccessKey?: string;
  readonly s3ForcePathStyle?: string;
  readonly envVars: Readonly<Record<string, string>>;
}

/**
 * Standardized storage selection question and S3-compatible configuration flow.
 * Shared across all fleet-provider-* packages.
 */
export async function promptStorageConfig(
  options: StoragePromptOptions,
): Promise<StoragePromptResult> {
  const { rl, provider, existingEnv = {}, nonInteractive } = options;
  const isNonInter = nonInteractive ?? (!rl || isNonInteractive());

  console.log(`\n${bold(cyan("── Storage Configuration ──"))}`);

  const defaultStorageProvider =
    existingEnv["STORAGE_PROVIDER"] === "s3" ? "s3" : "local";

  const storageChoice = await askChoice(
    rl,
    "Where will transcoded HLS output be stored?",
    [
      {
        label: "Local storage (stores in s3-bucket folder)",
        value: "local" as const,
      },
      {
        label:
          "S3 / S3-compatible storage (AWS S3, MinIO, Cloudflare R2, etc.)",
        value: "s3" as const,
      },
    ],
    defaultStorageProvider === "s3" ? 1 : 0,
    isNonInter,
  );

  if (storageChoice === "local") {
    ok(`Storage set to local (${bold("s3-bucket")} directory).`);
    return {
      storageProvider: "local",
      envVars: {
        STORAGE_PROVIDER: "local",
      },
    };
  }

  // storageChoice === "s3"
  if (provider === "aws") {
    const existingUseIam =
      existingEnv["S3_USE_INSTANCE_ROLE"] !== "false" &&
      !existingEnv["S3_ACCESS_KEY_ID"];

    const iamChoice = await askChoice(
      rl,
      "Use EC2 IAM instance role for S3 authentication?",
      [
        {
          label:
            "Use IAM role (recommended for AWS EC2 — automatic credentials, no access keys)",
          value: "iam" as const,
        },
        {
          label:
            "Skip IAM role (configure S3-compatible credentials: S3_BUCKET, S3_ENDPOINT, keys, etc.)",
          value: "skip" as const,
        },
      ],
      existingUseIam ? 0 : 1,
      isNonInter,
    );

    if (iamChoice === "iam") {
      return {
        storageProvider: "s3",
        useIamRole: true,
        envVars: {
          STORAGE_PROVIDER: "s3",
          S3_USE_INSTANCE_ROLE: "true",
        },
      };
    }
  }

  // Ask S3-compatible storage configuration questions:
  console.log(dim("\n  Configure S3-compatible storage credentials:"));

  const defaultBucket = existingEnv["S3_BUCKET"] || "veolms-media";
  const s3Bucket = await ask(
    rl,
    "S3 bucket name (S3_BUCKET)",
    defaultBucket,
    isNonInter,
  );

  const defaultEndpoint = existingEnv["S3_ENDPOINT"] || "";
  const s3Endpoint = await ask(
    rl,
    "S3 endpoint URL (S3_ENDPOINT) [leave empty for AWS S3, or e.g. http://localhost:9000 for MinIO]",
    defaultEndpoint,
    isNonInter,
  );

  const defaultRegion =
    existingEnv["S3_REGION"] || existingEnv["AWS_REGION"] || "us-east-1";
  const s3Region = await ask(
    rl,
    "S3 region (S3_REGION)",
    defaultRegion,
    isNonInter,
  );

  const defaultAccessKey =
    existingEnv["S3_ACCESS_KEY_ID"] || existingEnv["AWS_ACCESS_KEY_ID"] || "";
  const s3AccessKeyId = await ask(
    rl,
    "S3 Access Key ID (S3_ACCESS_KEY_ID)",
    defaultAccessKey,
    isNonInter,
  );

  const defaultSecretKey =
    existingEnv["S3_SECRET_ACCESS_KEY"] ||
    existingEnv["AWS_SECRET_ACCESS_KEY"] ||
    "";
  const s3SecretAccessKey = await ask(
    rl,
    "S3 Secret Access Key (S3_SECRET_ACCESS_KEY)",
    defaultSecretKey,
    isNonInter,
  );

  const defaultPathStyle =
    existingEnv["S3_FORCE_PATH_STYLE"] === "true" ||
    (s3Endpoint !== "" && existingEnv["S3_FORCE_PATH_STYLE"] !== "false")
      ? "true"
      : "false";

  const s3ForcePathStyle = await askChoice(
    rl,
    "Use path-style URLs (S3_FORCE_PATH_STYLE)? (recommended for MinIO/Floci)",
    [
      {
        label: "true (Path style: http://endpoint/bucket/key)",
        value: "true" as const,
      },
      {
        label: "false (Virtual hosted: http://bucket.endpoint/key)",
        value: "false" as const,
      },
    ],
    defaultPathStyle === "true" ? 0 : 1,
    isNonInter,
  );

  const envVars: Record<string, string> = {
    STORAGE_PROVIDER: "s3",
    S3_BUCKET: s3Bucket,
    S3_REGION: s3Region,
    S3_FORCE_PATH_STYLE: s3ForcePathStyle,
  };

  if (s3Endpoint) {
    envVars["S3_ENDPOINT"] = s3Endpoint;
  }
  if (s3AccessKeyId) {
    envVars["S3_ACCESS_KEY_ID"] = s3AccessKeyId;
  }
  if (s3SecretAccessKey) {
    envVars["S3_SECRET_ACCESS_KEY"] = s3SecretAccessKey;
  }

  ok(
    `Configured S3 storage: bucket ${bold(s3Bucket)}, region ${bold(s3Region)}`,
  );

  return {
    storageProvider: "s3",
    useIamRole: false,
    s3Bucket,
    s3Endpoint: s3Endpoint || undefined,
    s3Region,
    s3AccessKeyId: s3AccessKeyId || undefined,
    s3SecretAccessKey: s3SecretAccessKey || undefined,
    s3ForcePathStyle,
    envVars,
  };
}
