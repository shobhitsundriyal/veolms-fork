import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeUserDataBase64,
  generateUserDataScript,
  PINNED_FFMPEG_SHA256,
  PINNED_FFMPEG_VERSION,
} from "../src/bootstrapper.ts";

describe("EC2 UserData Bootstrapper Generator", () => {
  it("uses the standard bootstrap script for a Floci Docker-backed EC2 instance", () => {
    const script = generateUserDataScript({
      workerId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      spec: {
        cpu: 2,
        memoryMb: 4096,
        architecture: "x86_64",
        storageGb: 30,
        region: "us-east-1",
        environmentVariables: { DATABASE_URL: "postgresql://db/veolms" },
      },
      extraEnv: {
        AWS_ENDPOINT_URL: "http://floci:4566",
        S3_ENDPOINT: "http://floci:4566",
        S3_BUCKET: "veolms-floci-test",
      },
    });

    assert.ok(script.includes("node worker.js"));
    assert.ok(script.includes('AWS_ENDPOINT_URL="http://floci:4566"'));
    assert.ok(script.includes('S3_ENDPOINT="http://floci:4566"'));
    assert.ok(script.includes('S3_BUCKET="veolms-floci-test"'));
    assert.ok(script.includes("apt-get install"));
    assert.ok(script.includes("wait_for_apt_locks"));
    assert.ok(script.includes("after 300s"));
    assert.ok(script.includes("aws s3 cp"));
    assert.ok(script.includes("install_static_ffmpeg"));
    assert.ok(
      script.includes(
        "https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-${ffmpeg_version}-${ffmpeg_arch}-static.tar.xz",
      ),
    );
    assert.ok(
      script.includes(`local ffmpeg_version="${PINNED_FFMPEG_VERSION}"`),
    );
    assert.ok(script.includes("sha256sum"));
    assert.ok(script.includes(PINNED_FFMPEG_SHA256.arm64));
    assert.ok(!script.includes(".md5"));
  });
  it("should generate a bootstrapper script with environment variables and install-if-missing checks", () => {
    const script = generateUserDataScript({
      workerId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      spec: {
        cpu: 2,
        memoryMb: 4096,
        architecture: "arm64",
        storageGb: 30,
        region: "us-east-1",
        environmentVariables: {
          JOB_ID: "job-123",
          DATABASE_URL: "postgresql://veolms:veolms@db:5432/veolms",
        },
      },
    });

    assert.ok(script.startsWith("#!/bin/bash"));
    assert.ok(
      script.includes('WORKER_ID="a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"'),
    );
    assert.ok(script.includes('JOB_ID="job-123"'));
    assert.ok(script.includes("apt-get install"));
    assert.ok(script.includes("ffmpeg"));
    assert.ok(script.includes("xz-utils"));
    assert.ok(
      !script.includes(
        "apt_install_with_retry curl ca-certificates gnupg unzip ffmpeg",
      ),
    );
    assert.ok(script.includes("if ! command -v node"));
    assert.ok(script.includes("awscli"));
    assert.ok(script.includes('if [ "${IMAGE_WORKER_MODE:-false}" = "true" ]'));
    assert.ok(
      script.includes(
        "npm install --prefix /opt/veolms --no-save --no-package-lock",
      ),
    );
    assert.ok(
      script.includes(
        '--omit=dev --include=optional --os=linux --cpu="$SHARP_CPU" sharp@0.34.5',
      ),
    );
    assert.ok(script.includes("node -e 'require(\"sharp\")'"));
  });

  it("always installs a trap-based cleanup that uploads the log and terminates on any exit", () => {
    const script = generateUserDataScript({
      workerId: "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
      spec: {
        cpu: 4,
        memoryMb: 8192,
        architecture: "arm64",
        storageGb: 50,
        region: "us-east-1",
        environmentVariables: {
          JOB_ID: "job-456",
        },
      },
    });

    assert.ok(script.includes("trap cleanup_and_terminate EXIT"));
    assert.ok(script.includes("aws s3 cp /var/log/veolms-bootstrap.log"));
    assert.ok(script.includes("aws ec2 terminate-instances"));
    assert.ok(
      script.includes('WORKER_ID="b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22"'),
    );
  });

  it("resolves BUCKET_NAME only after worker.env has been sourced, not before", () => {
    const script = generateUserDataScript({
      workerId: "c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33",
      spec: {
        cpu: 2,
        memoryMb: 2048,
        architecture: "arm64",
        storageGb: 10,
        region: "us-east-1",
        environmentVariables: {},
      },
      extraEnv: { S3_BUCKET: "real-bucket-name" },
    });

    const sourceIndex = script.indexOf("source /opt/veolms/worker.env");
    const realResolutionIndex = script.indexOf('BUCKET_NAME="${S3_BUCKET:-}"');

    assert.ok(sourceIndex !== -1, "script must source worker.env");
    assert.ok(
      realResolutionIndex !== -1,
      "script must resolve BUCKET_NAME from S3_BUCKET",
    );
    assert.ok(
      realResolutionIndex > sourceIndex,
      "BUCKET_NAME must be resolved after worker.env is sourced, not before",
    );

    // And the download step (further down) must come after that real
    // resolution too, not accidentally reference an earlier empty default.
    const downloadIndex = script.indexOf('aws s3 cp "s3://$BUILD_BUCKET');
    assert.ok(downloadIndex > realResolutionIndex);
  });

  it("uploads bootstrap.log and worker.log to S3_BUILD_BUCKET when configured", () => {
    const script = generateUserDataScript({
      workerId: "d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a44",
      spec: {
        cpu: 2,
        memoryMb: 4096,
        architecture: "arm64",
        storageGb: 30,
        region: "us-east-1",
        environmentVariables: {
          S3_BUILD_BUCKET: "my-custom-build-bucket",
        },
      },
    });

    assert.ok(script.includes('S3_BUILD_BUCKET="my-custom-build-bucket"'));
    assert.ok(
      script.includes(
        '"s3://$LOG_BUCKET/worker-logs/d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a44/bootstrap.log"',
      ),
    );
    assert.ok(
      script.includes(
        '"s3://$LOG_BUCKET/worker-logs/d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a44/worker.log"',
      ),
    );
    assert.ok(
      script.includes(
        'aws s3 cp "s3://$BUILD_BUCKET/bundles/media-worker.js" /opt/veolms/worker.js',
      ),
    );
  });

  it("should encode UserData script to Base64", () => {
    const script = "#!/bin/bash\necho hello";
    const encoded = encodeUserDataBase64(script);
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");

    assert.equal(decoded, script);
  });
});
