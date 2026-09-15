import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as setupModule from "../src/setup/index.ts";
import * as destroyModule from "../src/setup/destroy.ts";
import { buildCicdPolicyDocument } from "../iam/setup-cicd-iam.ts";

describe("AWS Setup Module Interface", () => {
  it("should export runAwsInfraSetup function", () => {
    assert.equal(typeof setupModule.runAwsInfraSetup, "function");
  });

  it("should export runAwsInfraUpdate function", () => {
    assert.equal(typeof setupModule.runAwsInfraUpdate, "function");
  });

  it("should export runAwsInfraDestroy function from both index and destroy", () => {
    assert.equal(typeof setupModule.runAwsInfraDestroy, "function");
    assert.equal(typeof destroyModule.runAwsInfraDestroy, "function");
  });

  it("should export helper provisioning functions", () => {
    assert.equal(typeof setupModule.checkOrCreateRole, "function");
    assert.equal(typeof setupModule.createInstanceProfile, "function");
    assert.equal(typeof setupModule.buildAndUploadWorkerBundle, "function");
    assert.equal(typeof setupModule.buildAndUploadBuildArtifacts, "function");
    assert.equal(typeof setupModule.ensureSecurityGroup, "function");
    assert.equal(typeof setupModule.checkKeyPair, "function");
    assert.equal(typeof setupModule.runBuildAmi, "function");
    assert.equal(typeof setupModule.ensureSpotServiceLinkedRole, "function");
    assert.equal(typeof setupModule.runSetupCicdIam, "function");
  });

  it("scopes provisioner Lambda permission actions to managed functions", () => {
    const policy = JSON.parse(
      fs.readFileSync(
        new URL("../iam/infra-provisioner-policy.json", import.meta.url),
        "utf8",
      ),
    ) as {
      Statement: Array<{
        Sid: string;
        Action: string[];
        Resource: string | string[];
      }>;
    };
    const statement = policy.Statement.find(
      (entry) => entry.Sid === "LambdaPermissionManagement",
    );

    assert.ok(statement);
    assert.deepEqual(statement.Action, [
      "lambda:AddPermission",
      "lambda:RemovePermission",
    ]);
    assert.deepEqual(statement.Resource, [
      "arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:veolms-fleet-manager",
      "arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:veolms-video-metadata-probe",
    ]);
    const resources = Array.isArray(statement.Resource)
      ? statement.Resource
      : [statement.Resource];
    assert.ok(
      !resources.some((resource) => resource.includes(":lambda:*:*:function:")),
    );
  });

  it("should discover available AWS profiles without throwing", () => {
    const profiles = setupModule.listAvailableAwsProfiles();
    assert.ok(Array.isArray(profiles));
  });

  it("should correctly write initial .env and update them when re-running setup", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veolms-env-test-"));
    const fleetEnvDir = path.join(tempDir, "apps", "fleet-manager");
    const workerEnvDir = path.join(tempDir, "apps", "media-worker");
    fs.mkdirSync(fleetEnvDir, { recursive: true });
    fs.mkdirSync(workerEnvDir, { recursive: true });

    try {
      // 1. Initial Setup Generation
      const initialAnswers: any = {
        targetEnv: "aws",
        region: "ap-south-1",
        profile: "initial-profile",
        fleetMode: "serverless",
        databaseUrl: "postgresql://user:pass@localhost:5432/db",
        storageProvider: "s3",
        s3BucketName: "veolms-media-initial",
        s3BuildBucket: "veolms-build-initial",
        maxWorkers: 5,
        workerIdlePollSeconds: 15,
        useSpot: true,
        bootMode: "ami",
        amiId: "ami-initial-12345",
        allowedInstanceTypes: ["c7g.xlarge"],
      };

      const initialResult: any = {
        workerRoleArn: "arn:aws:iam::123456789012:role/VeoLMSWorkerRole",
        instanceProfileArn:
          "arn:aws:iam::123456789012:instance-profile/VeoLMSWorkerInstanceProfile",
        logGroupWorkers: "/veolms/workers",
        logGroupFleet: "/veolms/fleet-manager",
        lambdaFunctionArn:
          "arn:aws:lambda:ap-south-1:123456789012:function:veolms-fleet-manager",
        probeLambdaArn:
          "arn:aws:lambda:ap-south-1:123456789012:function:veolms-video-metadata-probe",
        s3BucketName: "veolms-media-initial",
        s3BuildBucket: "veolms-build-initial",
      };

      await setupModule.generateEnvFiles(
        initialAnswers,
        initialResult,
        tempDir,
      );

      const fleetEnvInitial = setupModule.parseEnvFile(
        path.join(fleetEnvDir, ".env"),
      );
      const workerEnvInitial = setupModule.parseEnvFile(
        path.join(workerEnvDir, ".env"),
      );

      assert.equal(fleetEnvInitial["AWS_REGION"], "ap-south-1");
      assert.equal(fleetEnvInitial["AWS_PROFILE"], "initial-profile");
      assert.equal(fleetEnvInitial["S3_BUCKET"], "veolms-media-initial");
      assert.equal(fleetEnvInitial["AMI_ID"], "ami-initial-12345");
      assert.equal(workerEnvInitial["AWS_REGION"], "ap-south-1");
      assert.equal(workerEnvInitial["AWS_PROFILE"], "initial-profile");

      // 2. Re-running Setup with Updated Values
      const updatedAnswers: any = {
        targetEnv: "aws",
        region: "us-east-1",
        profile: "production-profile",
        fleetMode: "serverless",
        databaseUrl: "postgresql://user:pass@localhost:5432/db",
        storageProvider: "s3",
        s3BucketName: "veolms-media-updated",
        s3BuildBucket: "veolms-build-updated",
        maxWorkers: 10,
        workerIdlePollSeconds: 20,
        useSpot: false,
        bootMode: "ami",
        amiId: "ami-updated-99999",
        allowedInstanceTypes: ["c7g.2xlarge"],
      };

      const updatedResult: any = {
        workerRoleArn: "arn:aws:iam::123456789012:role/VeoLMSWorkerRole",
        instanceProfileArn:
          "arn:aws:iam::123456789012:instance-profile/VeoLMSWorkerInstanceProfile",
        logGroupWorkers: "/veolms/workers",
        logGroupFleet: "/veolms/fleet-manager",
        lambdaFunctionArn:
          "arn:aws:lambda:us-east-1:123456789012:function:veolms-fleet-manager",
        probeLambdaArn:
          "arn:aws:lambda:us-east-1:123456789012:function:veolms-video-metadata-probe",
        s3BucketName: "veolms-media-updated",
        s3BuildBucket: "veolms-build-updated",
      };

      await setupModule.generateEnvFiles(
        updatedAnswers,
        updatedResult,
        tempDir,
      );

      const fleetEnvUpdated = setupModule.parseEnvFile(
        path.join(fleetEnvDir, ".env"),
      );
      const workerEnvUpdated = setupModule.parseEnvFile(
        path.join(workerEnvDir, ".env"),
      );

      // Verify that re-running infra setup updated all .env values correctly
      assert.equal(fleetEnvUpdated["AWS_REGION"], "us-east-1");
      assert.equal(fleetEnvUpdated["AWS_PROFILE"], "production-profile");
      assert.equal(fleetEnvUpdated["S3_BUCKET"], "veolms-media-updated");
      assert.equal(fleetEnvUpdated["AMI_ID"], "ami-updated-99999");
      assert.equal(fleetEnvUpdated["MAX_WORKERS"], "10");
      assert.equal(fleetEnvUpdated["EC2_USE_SPOT"], "false");

      assert.equal(workerEnvUpdated["AWS_REGION"], "us-east-1");
      assert.equal(workerEnvUpdated["AWS_PROFILE"], "production-profile");
      assert.equal(workerEnvUpdated["S3_BUCKET"], "veolms-media-updated");
      assert.equal(workerEnvUpdated["WORKER_IDLE_POLL_SECONDS"], "20");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should load S3_BUCKET_ACCESS and AMI_NAME from combined config in loadExistingConfig", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veolms-cfg-test-"));
    const fleetEnvDir = path.join(tempDir, "apps", "fleet-manager");
    fs.mkdirSync(fleetEnvDir, { recursive: true });

    const origArgv = [...process.argv];
    const origBucketAccess = process.env.S3_BUCKET_ACCESS;
    const origAmiName = process.env.AMI_NAME;
    try {
      process.argv = ["node", "setup.ts"];
      delete process.env.S3_BUCKET_ACCESS;
      delete process.env.AMI_NAME;
      fs.writeFileSync(
        path.join(fleetEnvDir, ".env"),
        "S3_BUCKET_ACCESS=public\nAMI_NAME=my-prebaked-ami\n",
      );

      const config = setupModule.loadExistingConfig(tempDir);
      assert.equal(config.s3BucketAccess, "public");
      assert.equal(config.amiName, "my-prebaked-ami");
    } finally {
      process.argv = origArgv;
      if (origBucketAccess === undefined) delete process.env.S3_BUCKET_ACCESS;
      else process.env.S3_BUCKET_ACCESS = origBucketAccess;
      if (origAmiName === undefined) delete process.env.AMI_NAME;
      else process.env.AMI_NAME = origAmiName;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should preserve CLI-provided values for --public-bucket and --ami-name over .env in loadExistingConfig", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veolms-cfg-test-"));
    const fleetEnvDir = path.join(tempDir, "apps", "fleet-manager");
    fs.mkdirSync(fleetEnvDir, { recursive: true });

    const origArgv = [...process.argv];
    const origBucketAccess = process.env.S3_BUCKET_ACCESS;
    const origAmiName = process.env.AMI_NAME;
    try {
      delete process.env.S3_BUCKET_ACCESS;
      delete process.env.AMI_NAME;
      fs.writeFileSync(
        path.join(fleetEnvDir, ".env"),
        "S3_BUCKET_ACCESS=private\nAMI_NAME=env-ami-name\n",
      );

      process.argv = [
        "node",
        "setup.ts",
        "--public-bucket",
        "--ami-name=cli-custom-ami",
      ];

      const config = setupModule.loadExistingConfig(tempDir);
      assert.equal(config.s3BucketAccess, "public");
      assert.equal(config.amiName, "cli-custom-ami");
    } finally {
      process.argv = origArgv;
      if (origBucketAccess === undefined) delete process.env.S3_BUCKET_ACCESS;
      else process.env.S3_BUCKET_ACCESS = origBucketAccess;
      if (origAmiName === undefined) delete process.env.AMI_NAME;
      else process.env.AMI_NAME = origAmiName;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should have s3:DeleteObject and s3:DeleteObjectVersion in cicd-infra-deployer-policy.json", () => {
    const policyPath = path.join(
      import.meta.dirname,
      "..",
      "iam",
      "cicd-infra-deployer-policy.json",
    );
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf-8"));
    const s3Statement = policy.Statement.find(
      (s: { Sid: string }) => s.Sid === "S3BuildBucketUploadAndRead",
    );
    assert.ok(s3Statement, "S3BuildBucketUploadAndRead statement should exist");
    assert.ok(s3Statement.Action.includes("s3:DeleteObject"));
    assert.ok(s3Statement.Action.includes("s3:DeleteObjectVersion"));
  });

  it("should generate the CI/CD policy with bundle-scoped S3 permissions", () => {
    const policy = JSON.parse(
      buildCicdPolicyDocument({
        bucketName: "build-bucket",
        region: "ap-south-1",
        accountId: "123456789012",
      }),
    );
    const objectStatement = policy.Statement.find(
      (s: { Sid: string }) => s.Sid === "S3BuildBucketUploadAndRead",
    );
    const listStatement = policy.Statement.find(
      (s: { Sid: string }) => s.Sid === "S3BuildBucketListBundles",
    );

    assert.equal(
      objectStatement.Resource,
      "arn:aws:s3:::build-bucket/bundles/*",
    );
    assert.ok(!objectStatement.Action.includes("s3:HeadObject"));
    assert.ok(!objectStatement.Action.includes("s3:ListBucket"));
    assert.equal(listStatement.Resource, "arn:aws:s3:::build-bucket");
    assert.deepEqual(listStatement.Condition, {
      StringLike: { "s3:prefix": ["bundles/", "bundles/*"] },
    });
  });

  it("should allow the CI/CD IAM user to invoke the fleet Lambda functions", () => {
    const policyPath = path.join(
      import.meta.dirname,
      "..",
      "iam",
      "cicd-infra-deployer-policy.json",
    );
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf-8"));
    const invokeStatement = policy.Statement.find(
      (s: { Sid: string }) => s.Sid === "LambdaFunctionInvocation",
    );
    assert.ok(
      invokeStatement,
      "LambdaFunctionInvocation statement should exist",
    );
    assert.deepEqual(invokeStatement.Action, ["lambda:InvokeFunction"]);
    assert.equal(invokeStatement.Resource.length, 2);
  });

  it("should write local storage provider without S3 bucket", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veolms-env-local-"));
    const fleetEnvDir = path.join(tempDir, "apps", "fleet-manager");
    const workerEnvDir = path.join(tempDir, "apps", "media-worker");
    fs.mkdirSync(fleetEnvDir, { recursive: true });
    fs.mkdirSync(workerEnvDir, { recursive: true });

    try {
      const answers: any = {
        targetEnv: "aws",
        region: "us-east-1",
        fleetMode: "serverless",
        databaseUrl: "postgresql://localhost:5432/db",
        storageProvider: "local",
        s3BucketName: null,
        maxWorkers: 2,
        workerIdlePollSeconds: 15,
        useSpot: true,
        bootMode: "ami",
        allowedInstanceTypes: ["c7g.large"],
      };
      const result: any = {
        workerRoleArn: "arn:aws:iam::123:role/r",
        instanceProfileArn: "arn:aws:iam::123:instance-profile/p",
        logGroupWorkers: "/w",
        logGroupFleet: "/f",
        lambdaFunctionArn: null,
        probeLambdaArn: null,
        s3BucketName: null,
      };

      await setupModule.generateEnvFiles(answers, result, tempDir);

      const fleetEnv = setupModule.parseEnvFile(path.join(fleetEnvDir, ".env"));
      const workerEnv = setupModule.parseEnvFile(
        path.join(workerEnvDir, ".env"),
      );

      assert.equal(fleetEnv["STORAGE_PROVIDER"], "local");
      assert.equal(workerEnv["STORAGE_PROVIDER"], "local");
      assert.equal(fleetEnv["S3_BUCKET"], undefined);
      assert.equal(workerEnv["S3_BUCKET"], undefined);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should write S3-compatible credentials to .env files", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veolms-env-s3-"));
    const fleetEnvDir = path.join(tempDir, "apps", "fleet-manager");
    const workerEnvDir = path.join(tempDir, "apps", "media-worker");
    fs.mkdirSync(fleetEnvDir, { recursive: true });
    fs.mkdirSync(workerEnvDir, { recursive: true });

    try {
      const answers: any = {
        targetEnv: "aws",
        region: "us-east-1",
        fleetMode: "serverless",
        databaseUrl: "postgresql://localhost:5432/db",
        storageProvider: "s3",
        s3BucketName: "minio-media",
        s3Endpoint: "http://localhost:9000",
        s3Region: "us-east-1",
        s3AccessKeyId: "minioadmin",
        s3SecretAccessKey: "miniopassword",
        s3ForcePathStyle: "true",
        maxWorkers: 2,
        workerIdlePollSeconds: 15,
        useSpot: true,
        bootMode: "ami",
        allowedInstanceTypes: ["c7g.large"],
      };
      const result: any = {
        workerRoleArn: "arn:aws:iam::123:role/r",
        instanceProfileArn: "arn:aws:iam::123:instance-profile/p",
        logGroupWorkers: "/w",
        logGroupFleet: "/f",
        lambdaFunctionArn: null,
        probeLambdaArn: null,
        s3BucketName: "minio-media",
      };

      await setupModule.generateEnvFiles(answers, result, tempDir);

      const fleetEnv = setupModule.parseEnvFile(path.join(fleetEnvDir, ".env"));
      const workerEnv = setupModule.parseEnvFile(
        path.join(workerEnvDir, ".env"),
      );

      assert.equal(fleetEnv["STORAGE_PROVIDER"], "s3");
      assert.equal(fleetEnv["S3_BUCKET"], "minio-media");
      assert.equal(fleetEnv["S3_ENDPOINT"], "http://localhost:9000");
      assert.equal(fleetEnv["S3_ACCESS_KEY_ID"], "minioadmin");
      assert.equal(fleetEnv["S3_SECRET_ACCESS_KEY"], "miniopassword");
      assert.equal(fleetEnv["S3_FORCE_PATH_STYLE"], "true");

      assert.equal(workerEnv["STORAGE_PROVIDER"], "s3");
      assert.equal(workerEnv["S3_BUCKET"], "minio-media");
      assert.equal(workerEnv["S3_ENDPOINT"], "http://localhost:9000");
      assert.equal(workerEnv["S3_ACCESS_KEY_ID"], "minioadmin");
      assert.equal(workerEnv["S3_SECRET_ACCESS_KEY"], "miniopassword");
      assert.equal(workerEnv["S3_FORCE_PATH_STYLE"], "true");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should write Floci endpoint, test credentials, and container database URL", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veolms-env-floci-"));
    const fleetEnvDir = path.join(tempDir, "apps", "fleet-manager");
    const workerEnvDir = path.join(tempDir, "apps", "media-worker");
    fs.mkdirSync(fleetEnvDir, { recursive: true });
    fs.mkdirSync(workerEnvDir, { recursive: true });

    try {
      await setupModule.generateEnvFiles(
        {
          targetEnv: "floci",
          endpointUrl: "http://localhost:4566",
          region: "us-east-1",
          fleetMode: "serverless",
          databaseUrl: "postgresql://veolms:veolms@localhost:5433/veolms",
          containerDatabaseUrl:
            "postgresql://veolms:veolms@postgres:5432/veolms",
          storageProvider: "s3",
          s3BucketName: "veolms-floci-media",
          s3BuildBucket: "veolms-floci-build",
          s3CredentialMode: "automatic",
          maxWorkers: 2,
          workerIdlePollSeconds: 15,
          useSpot: false,
          bootMode: "fresh",
          amiId: "ami-ubuntu2404",
          allowedInstanceTypes: ["c7g.large"],
        } as any,
        {
          workerRoleArn: "arn:aws:iam::000000000000:role/r",
          instanceProfileArn: "arn:aws:iam::000000000000:instance-profile/p",
          logGroupWorkers: "/w",
          logGroupFleet: "/f",
          lambdaFunctionArn:
            "arn:aws:lambda:us-east-1:000000000000:function:veolms-fleet-manager",
          probeLambdaArn: null,
          s3BucketName: "veolms-floci-media",
          s3BuildBucket: "veolms-floci-build",
        } as any,
        tempDir,
      );

      const fleetEnv = setupModule.parseEnvFile(path.join(fleetEnvDir, ".env"));
      const workerEnv = setupModule.parseEnvFile(
        path.join(workerEnvDir, ".env"),
      );

      assert.equal(fleetEnv["FLOCI_ENDPOINT"], "http://localhost:4566");
      assert.equal(fleetEnv["AWS_ENDPOINT_URL"], "http://localhost:4566");
      assert.equal(fleetEnv["AWS_ACCESS_KEY_ID"], "test");
      assert.equal(fleetEnv["AWS_SECRET_ACCESS_KEY"], "test");
      assert.equal(
        fleetEnv["FLOCI_DATABASE_URL"],
        "postgresql://veolms:veolms@postgres:5432/veolms",
      );
      assert.equal(fleetEnv["AMI_ID"], "ami-ubuntu2404");
      assert.equal(workerEnv["FLOCI_ENDPOINT"], "http://localhost:4566");
      assert.equal(workerEnv["S3_ACCESS_KEY_ID"], "test");
      assert.equal(workerEnv["S3_SECRET_ACCESS_KEY"], "test");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should load S3-compatible credentials in loadExistingConfig", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veolms-cfg-s3-"));
    const fleetEnvDir = path.join(tempDir, "apps", "fleet-manager");
    fs.mkdirSync(fleetEnvDir, { recursive: true });

    const envKeys = [
      "STORAGE_PROVIDER",
      "STORAGE_BUCKET",
      "S3_BUCKET",
      "S3_BUILD_BUCKET",
      "S3_ENDPOINT",
      "S3_REGION",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_FORCE_PATH_STYLE",
      "S3_USE_INSTANCE_ROLE",
      "FLOCI_ENDPOINT",
      "AWS_ENDPOINT_URL",
      "AWS_REGION",
      "AWS_PROFILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "DATABASE_URL",
      "FLOCI_DATABASE_URL",
      "FLEET_MODE",
      "EC2_ALLOWED_INSTANCE_TYPES",
      "EC2_BOOT_MODE",
      "AMI_ID",
      "AMI_NAME",
      "MAX_WORKERS",
      "WORKER_IDLE_POLL_SECONDS",
      "EC2_USE_SPOT",
      "ALLOW_SSH",
      "EC2_KEY_NAME",
      "KEY_NAME",
      "SECURITY_GROUP_IDS",
      "EC2_SECURITY_GROUP_IDS",
      "EC2_SECURITY_GROUP_ID",
      "LAMBDA_ARCHITECTURE",
      "SETUP_PROBE_LAMBDA",
      "LAMBDA_FUNCTION_ARN",
      "PROBE_LAMBDA_ARN",
      "PROBE_LAMBDA_NAME",
    ];
    const originalEnv = new Map(
      envKeys.map((key) => [key, process.env[key]] as const),
    );

    try {
      for (const key of envKeys) {
        delete process.env[key];
      }
      fs.writeFileSync(
        path.join(fleetEnvDir, ".env"),
        "STORAGE_PROVIDER=s3\nS3_BUCKET=r2-media\nS3_ENDPOINT=https://r2.cloudflarestorage.com\nS3_ACCESS_KEY_ID=key123\nS3_SECRET_ACCESS_KEY=sec456\nS3_FORCE_PATH_STYLE=true\n",
      );

      const config = setupModule.loadExistingConfig(tempDir);
      assert.equal(config.storageProvider, "s3");
      assert.equal(config.s3BucketName, "r2-media");
      assert.equal(config.s3Endpoint, "https://r2.cloudflarestorage.com");
      assert.equal(config.s3AccessKeyId, "key123");
      assert.equal(config.s3SecretAccessKey, "sec456");
      assert.equal(config.s3ForcePathStyle, "true");
    } finally {
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
