import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  awsCliEndpointArgs,
  awsS3ClientOptions,
  awsServiceClientOptions,
  isFlociConfigured,
  isLocalDatabaseUrl,
  resolveFlociContainerDatabaseUrl,
  resolveFlociEndpoint,
} from "../src/floci.ts";
import { resolveS3BucketName } from "../src/config.ts";

describe("Floci AWS endpoint configuration", () => {
  it("prefers FLOCI_ENDPOINT and recognizes the local target", () => {
    const env = {
      FLOCI_ENDPOINT: " http://floci:4566/ ",
      AWS_ENDPOINT_URL: "http://unused:4566",
    };

    assert.equal(resolveFlociEndpoint(env), "http://floci:4566/");
    assert.equal(isFlociConfigured(env), true);
  });

  it("pins service and S3 clients to Floci with deterministic credentials", () => {
    const env = {
      FLOCI_ENDPOINT: "http://localhost:4566",
    };

    assert.deepEqual(awsServiceClientOptions("us-east-1", env), {
      region: "us-east-1",
      endpoint: "http://localhost:4566",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    assert.deepEqual(awsS3ClientOptions("us-east-1", env), {
      region: "us-east-1",
      endpoint: "http://localhost:4566",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      forcePathStyle: true,
    });
    assert.deepEqual(awsCliEndpointArgs("http://localhost:4566"), [
      "--endpoint-url",
      "http://localhost:4566",
    ]);
  });

  it("leaves the AWS client configuration unchanged when no Floci endpoint is set", () => {
    const originalFlociEndpoint = process.env.FLOCI_ENDPOINT;
    const originalAwsEndpoint = process.env.AWS_ENDPOINT_URL;
    delete process.env.FLOCI_ENDPOINT;
    delete process.env.AWS_ENDPOINT_URL;
    try {
      assert.deepEqual(awsServiceClientOptions("eu-west-1", {}), {
        region: "eu-west-1",
      });
      assert.deepEqual(awsS3ClientOptions("eu-west-1", {}), {
        region: "eu-west-1",
      });
      assert.deepEqual(awsCliEndpointArgs(undefined), []);
      assert.equal(isFlociConfigured({}), false);
    } finally {
      if (originalFlociEndpoint === undefined) {
        delete process.env.FLOCI_ENDPOINT;
      } else {
        process.env.FLOCI_ENDPOINT = originalFlociEndpoint;
      }
      if (originalAwsEndpoint === undefined) {
        delete process.env.AWS_ENDPOINT_URL;
      } else {
        process.env.AWS_ENDPOINT_URL = originalAwsEndpoint;
      }
    }
  });

  it("does not reinterpret an arbitrary production AWS endpoint as Floci", () => {
    assert.equal(
      resolveFlociEndpoint({
        AWS_ENDPOINT_URL: "https://s3.us-east-1.amazonaws.com",
      }),
      undefined,
    );
    assert.equal(
      resolveFlociEndpoint({ AWS_ENDPOINT_URL: "http://floci:4566" }),
      "http://floci:4566",
    );
  });

  it("reuses a hosted fleet database inside Floci containers", () => {
    const hostedDatabaseUrl =
      "postgresql://owner:secret@ep-example.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

    assert.equal(isLocalDatabaseUrl(hostedDatabaseUrl), false);
    assert.equal(
      resolveFlociContainerDatabaseUrl(hostedDatabaseUrl),
      hostedDatabaseUrl,
    );
    assert.equal(
      resolveFlociContainerDatabaseUrl(
        hostedDatabaseUrl,
        "postgresql://custom@db/veolms",
      ),
      "postgresql://custom@db/veolms",
    );
  });

  it("keeps the local Compose database fallback for local URLs", () => {
    assert.equal(
      isLocalDatabaseUrl("postgresql://veolms@localhost:5433/veolms"),
      true,
    );
    assert.equal(
      resolveFlociContainerDatabaseUrl(
        "postgresql://veolms@localhost:5433/veolms",
      ),
      "postgresql://veolms:veolms@postgres:5432/veolms",
    );
  });

  it("accepts the root app storage bucket name for AWS setup", () => {
    assert.equal(
      resolveS3BucketName({ STORAGE_BUCKET: "procodrr-media" }),
      "procodrr-media",
    );
    assert.equal(
      resolveS3BucketName({
        S3_BUCKET: "fleet-media",
        STORAGE_BUCKET: "procodrr-media",
      }),
      "fleet-media",
    );
  });
});
