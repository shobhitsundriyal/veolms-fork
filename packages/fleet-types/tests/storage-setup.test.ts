import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { promptStorageConfig } from "../src/storage-setup.ts";

function createMockRl(responses: string[], secret: string) {
  const input = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    isRaw: boolean;
    isPaused: () => boolean;
    setRawMode: (mode: boolean) => EventEmitter;
  };
  let paused = false;
  input.isTTY = true;
  input.isRaw = false;
  input.isPaused = () => paused;
  input.pause = () => {
    paused = true;
    return input;
  };
  input.resume = () => {
    paused = false;
    return input;
  };
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
    return input;
  };
  const originalOn = input.on.bind(input);
  input.on = ((event: string, listener: (...args: any[]) => void) => {
    const result = originalOn(event, listener);
    if (event === "data") {
      queueMicrotask(() => input.emit("data", `${secret}\r\n`));
    }
    return result;
  }) as typeof input.on;
  const output = { write: () => true };
  return {
    question: async () => responses.shift() ?? "",
    input,
    output,
  } as any;
}

describe("Storage Setup Prompt", () => {
  it("selects local storage and generates local env vars", async () => {
    const responses = ["1"]; // choice 1: local
    const mockRl = {
      question: async () => responses.shift() ?? "",
    } as any;

    const result = await promptStorageConfig({
      rl: mockRl,
      provider: "local",
      nonInteractive: false,
    });

    assert.equal(result.storageProvider, "local");
    assert.equal(result.envVars["STORAGE_PROVIDER"], "local");
    assert.equal(result.envVars["S3_BUCKET"], undefined);
  });

  it("selects s3 with IAM role for AWS provider", async () => {
    const responses = [
      "2", // choice 2: S3
      "1", // choice 1: Use IAM role
    ];
    const mockRl = {
      question: async () => responses.shift() ?? "",
    } as any;

    const result = await promptStorageConfig({
      rl: mockRl,
      provider: "aws",
      nonInteractive: false,
    });

    assert.equal(result.storageProvider, "s3");
    assert.equal(result.useIamRole, true);
    assert.equal(result.envVars["STORAGE_PROVIDER"], "s3");
    assert.equal(result.envVars["S3_USE_INSTANCE_ROLE"], "true");
  });

  it("selects s3 and skips IAM role for AWS, collecting custom S3 credentials", async () => {
    const responses = [
      "2", // choice 2: S3
      "2", // choice 2: Skip IAM role
      "my-custom-bucket", // bucket
      "http://minio:9000", // endpoint
      "us-west-2", // region
      "minioadmin", // access key
      "1", // path style: true
    ];
    const mockRl = createMockRl(responses, "miniopassword");

    const result = await promptStorageConfig({
      rl: mockRl,
      provider: "aws",
      nonInteractive: false,
    });

    assert.equal(result.storageProvider, "s3");
    assert.equal(result.useIamRole, false);
    assert.equal(result.s3Bucket, "my-custom-bucket");
    assert.equal(result.s3Endpoint, "http://minio:9000");
    assert.equal(result.s3Region, "us-west-2");
    assert.equal(result.s3AccessKeyId, "minioadmin");
    assert.equal(result.s3SecretAccessKey, "miniopassword");
    assert.equal(result.s3ForcePathStyle, "true");

    assert.equal(result.envVars["STORAGE_PROVIDER"], "s3");
    assert.equal(result.envVars["S3_BUCKET"], "my-custom-bucket");
    assert.equal(result.envVars["S3_ENDPOINT"], "http://minio:9000");
    assert.equal(result.envVars["S3_REGION"], "us-west-2");
    assert.equal(result.envVars["S3_ACCESS_KEY_ID"], "minioadmin");
    assert.equal(result.envVars["S3_SECRET_ACCESS_KEY"], "miniopassword");
    assert.equal(result.envVars["S3_FORCE_PATH_STYLE"], "true");
  });

  it("selects s3 for docker provider and collects custom S3 credentials without asking IAM question", async () => {
    const responses = [
      "2", // choice 2: S3
      "docker-s3-bucket", // bucket
      "", // endpoint (empty)
      "eu-central-1", // region
      "AKIA_TEST", // access key
      "2", // path style: false
    ];
    const mockRl = createMockRl(responses, "SECRET_TEST");

    const result = await promptStorageConfig({
      rl: mockRl,
      provider: "docker",
      nonInteractive: false,
    });

    assert.equal(result.storageProvider, "s3");
    assert.equal(result.s3Bucket, "docker-s3-bucket");
    assert.equal(result.s3Endpoint, undefined);
    assert.equal(result.s3Region, "eu-central-1");
    assert.equal(result.s3AccessKeyId, "AKIA_TEST");
    assert.equal(result.s3SecretAccessKey, "SECRET_TEST");
    assert.equal(result.s3ForcePathStyle, "false");
    assert.equal(result.envVars["S3_ENDPOINT"], undefined);
  });
});
