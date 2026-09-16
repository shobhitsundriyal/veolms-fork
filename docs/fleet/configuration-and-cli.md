# Configuration Reference

This document defines all environment variables, defaults, and configuration options used by the **Fleet Manager** and **AWS Provider**.

---

## Configuration Variables

### Fleet Manager Core Configuration (`apps/fleet-manager/.env`)

| Variable                      | Type                           | Default                                            | Description                                                                                          |
| ----------------------------- | ------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | `string`                       | `postgresql://veolms:veolms@localhost:5433/veolms` | PostgreSQL connection string.                                                                        |
| `FLEET_MODE`                  | `"serverless" \| "serverful"`  | `"serverless"`                                     | Runtimes: Lambda event-driven (`serverless`) or daemon loop (`serverful`).                           |
| `FLEET_PROVIDER` / `PROVIDER` | `"aws" \| "docker" \| "local"` | `"local"`                                          | Compute provider package to load dynamically.                                                        |
| `MAX_WORKERS`                 | `number`                       | `8`                                                | Maximum concurrent active worker instances allowed.                                                  |
| `MAX_RETRIES`                 | `number`                       | `3`                                                | Maximum automatic retry attempts before marking a job `failed`.                                      |
| `HEARTBEAT_TIMEOUT_SECONDS`   | `number`                       | `90`                                               | Seconds without a heartbeat before a worker is marked dead.                                          |
| `POLL_INTERVAL_MS`            | `number`                       | `2000`                                             | Polling tick interval when running in serverful daemon mode.                                         |
| `FLOCI_ENDPOINT`              | `string`                       | unset                                              | Local Floci endpoint; setting it pins the AWS provider to Floci instead of AWS.                      |
| `FLOCI_DATABASE_URL`          | `string`                       | unset                                              | Optional override for Floci Lambda/EC2 containers; otherwise a hosted root `DATABASE_URL` is reused. |

### Local Docker Fleet Configuration

| Variable                           | Default                     | Description                                                                |
| ---------------------------------- | --------------------------- | -------------------------------------------------------------------------- |
| `DOCKER_WORKER_IMAGE`              | `veolms-media-worker:local` | One-job worker image.                                                      |
| `DOCKER_NETWORK`                   | unset                       | Compose network used by manager, worker, and PostgreSQL.                   |
| `DOCKER_STORAGE_ROOT`              | `s3-bucket/`                | Host-visible shared input/output folder.                                   |
| `DOCKER_VERIFICATION_STORAGE_ROOT` | `DOCKER_STORAGE_ROOT`       | Manager-visible mount used to verify `master.m3u8`.                        |
| `DOCKER_TRANSPORT`                 | `cli`                       | `socket` for Compose/Floci; avoids requiring a Docker CLI in the runtime.  |
| `DOCKER_SOCKET_GID`                | `0`                         | Supplementary group for the Docker socket when the manager runs as `node`. |
| `FLEET_TEST_MODE`                  | `false`                     | Enables guarded fault controls.                                            |

### AWS Provider Configuration (`packages/fleet-provider-aws`)

| Variable                     | Type               | Default                         | Description                                                                                                 |
| ---------------------------- | ------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `AWS_REGION`                 | `string`           | `"us-east-1"`                   | Target AWS region.                                                                                          |
| `EC2_IAM_INSTANCE_PROFILE`   | `string`           | `"VeoLMSWorkerInstanceProfile"` | IAM instance profile attached to EC2 instances.                                                             |
| `EC2_USE_SPOT`               | `boolean`          | `true`                          | Launch workers as EC2 Spot instances for cost reduction.                                                    |
| `EC2_ALLOWED_INSTANCE_TYPES` | `string`           | `undefined`                     | Optional comma-separated instance allowlist (exact types like `c7g.large` or wildcards like `c7g.*,c8g.*`). |
| `EC2_BOOT_MODE`              | `"fresh" \| "ami"` | `"fresh"`                       | Fast boot with pre-baked AMI or fresh bootstrap install.                                                    |
| `S3_BUCKET`                  | `string`           | _optional_                      | Primary video storage and HLS destination bucket.                                                           |
| `S3_BUILD_BUCKET`            | `string`           | _optional_                      | Bucket for worker bundle and Lambda package artifacts.                                                      |
| `S3_ENDPOINT`                | `string`           | _optional_                      | S3-compatible endpoint; the Floci setup sets this to its local endpoint.                                    |
| `S3_FORCE_PATH_STYLE`        | `boolean`          | `false`                         | Required for path-style S3 requests against Floci and many S3-compatible services.                          |
| `SECURITY_GROUP_IDS`         | `string`           | _optional_                      | Security Group ID with outbound access and optional SSH port 22.                                            |
| `KEY_NAME`                   | `string`           | _optional_                      | EC2 Key Pair name for SSH access.                                                                           |
| `LAMBDA_FUNCTION_ARN`        | `string`           | _optional_                      | ARN of the deployed serverless `veolms-fleet-manager` Lambda.                                               |
| `SCHEDULER_ROLE_ARN`         | `string`           | _optional_                      | IAM role ARN used by EventBridge Scheduler to invoke the Fleet Manager Lambda.                              |
| `PROBE_LAMBDA_NAME`          | `string`           | `"veolms-video-metadata-probe"` | Name of the video metadata probing Lambda function.                                                         |
| `FFPROBE_LAYER_ARN`          | `string`           | _optional_                      | ARN of the published `veolms-ffprobe` layer.                                                                |

When serverless mode and S3 storage are enabled, `pnpm fleet:infra` also
registers `s3://<bucket>/raw/*.mp4` as an S3 ObjectCreated notification for
the probe Lambda. The probe extracts metadata and invokes the Fleet Manager
Lambda by its configured function name. API-managed uploads still dispatch
after upload confirmation so their canonical media/output paths are retained.
For local Floci, run `pnpm fleet:infra` and keep the generated host-side
`FLOCI_ENDPOINT`/`AWS_ENDPOINT_URL` values in `apps/fleet-manager/.env` and
`apps/media-worker/.env`. The Fleet CLI reads those app env files and
`process.env`; the project-root `.env` is used for Compose interpolation. Floci
injects its internal service hostname into Lambda and EC2 containers, so a
host URL such as `http://localhost:4566` is not copied into their environment.

---

## Operational CLI Commands

For the complete command matrix, workflow examples, and execution details for all fleet commands (`pnpm fleet:provider`, `pnpm fleet:infra`, `pnpm fleet:destroy`, `pnpm fleet:queue:trigger`, and `pnpm fleet:cli`), see the dedicated reference:

👉 **[`docs/fleet-commands-and-operations.md`](../fleet-commands-and-operations.md)**
