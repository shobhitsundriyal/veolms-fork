# VeoLMS AWS Fleet Provider (`@veolms/fleet-provider-aws`)

AWS infrastructure provider for the VeoLMS transcoding pipeline. Manages ephemeral **EC2 Spot/On-Demand Graviton arm64 and x86_64 instances**, **AWS EventBridge Scheduler dynamic triggers**, **S3 bundle and output verification**, and automated setup CLI tooling.

---

## Features

- **EC2 Spot & On-Demand Lifecycle**: Launches Graviton (`c7g.*`, `t4g.*`) or Intel/AMD (`c6i.*`, `t3.*`) workers tailored to the computed video job hardware requirements.
- **Video Metadata Probe Lambda (`veolms-video-metadata-probe`)**: Pre-probes video resolution, duration, FPS, and codecs via `ffprobe` over presigned S3 URLs, forwarding enriched payloads to Fleet Manager.
- **Direct Cancellation Forwarding**: Forwards cancellation events (`{ jobId, status: "cancelled" }`) directly from the Probe Lambda to Fleet Manager without probing.
- **Dynamic Debian 13 AMI Resolution**: Resolves latest Debian point-release AMIs via AWS public SSM parameters (`/aws/service/debian/release/13/latest/${arch}`) with a 6-hour TTL cache.
- **Pre-baked AMI Builder**: Interactive builder (`pnpm fleet:build-ami`) creates custom AMIs with Node.js 24, FFmpeg, AWS CLI, and architecture-matched `sharp` pre-installed for **<30s boot times**.
- **Trap-Protected UserData Bootstrapper**: Slices environment variables securely into `/opt/veolms/worker.env`, downloads the bundled media-worker from S3, and executes with a trap that automatically uploads logs to S3 and terminates the EC2 instance on any failure or exit.
- **AWS EventBridge Scheduler Dynamic Triggers**: Creates one-shot `at(timestamp)` schedules targeting the Fleet Manager Lambda via `@aws-sdk/client-scheduler`, deleting them automatically when no active workers remain.
- **Two-Way Cluster Discovery**: Lists and maps real EC2 instance states with tag filters (`tag:ManagedBy=veolms-fleet-manager`) for cluster reconciliation.
- **S3 Output Verification & Cleanup**: Verifies `master.m3u8` playlists and segment uploads in S3 before marking jobs complete, and automatically purges S3 files on job cancellation.
- **Floci Local Emulator**: Runs the same AWS SDK/provider path against Floci's Docker-backed IAM, S3, Lambda, EC2, EventBridge Scheduler, and CloudWatch Logs APIs without contacting AWS.

---

## File Structure

```
packages/fleet-provider-aws/
├── src/
│   ├── bootstrapper.ts        # UserData script template generator & Base64 encoder
│   ├── bootstrap-script.sh    # Bash bootstrap script executed on EC2 boot
│   ├── config.ts              # Zod environment & AWS configuration loader
│   ├── debian-ami.ts          # Public Debian SSM AMI ID resolver with caching
│   ├── index.ts               # Package public exports
│   ├── instance-types.ts      # arm64 & x86_64 EC2 profile matching table
│   ├── lambda.ts              # AWS Lambda entrypoint adapter
│   ├── provider.ts            # FleetProvider implementation (EC2, SSM, S3, Scheduler)
│   ├── scheduler.ts           # EventBridge Scheduler client & one-shot triggers
│   └── setup/
│       ├── aws-cli-check.ts   # AWS CLI / STS credential validator
│       ├── build-ami.ts       # Pre-baked worker AMI builder
│       ├── destroy.ts         # Infrastructure teardown script
│       └── index.ts           # Interactive infrastructure setup CLI
└── tests/
    ├── aws-provider.test.ts   # Provider & instance mapping tests
    ├── bootstrapper.test.ts   # UserData & trap tests
    ├── instance-types.test.ts # Instance profile selector tests
    ├── scheduler.test.ts      # EventBridge Scheduler tests
    └── setup-actions.test.ts  # Setup export verification tests
```

---

## Configuration Variables

| Variable                                        | Description                                                         | Default                       |
| :---------------------------------------------- | :------------------------------------------------------------------ | :---------------------------- |
| `AWS_REGION`                                    | AWS region for EC2, S3, SSM, and EventBridge Scheduler              | `us-east-1`                   |
| `FLOCI_ENDPOINT` / `AWS_ENDPOINT_URL`           | Local Floci endpoint; when set, all AWS SDK calls use this endpoint | _Unset (real AWS)_            |
| `S3_ENDPOINT`                                   | Optional S3-compatible endpoint for non-Floci storage               | _Optional_                    |
| `S3_FORCE_PATH_STYLE`                           | Use path-style S3 requests (required by the local Floci setup)      | `false`                       |
| `EC2_USE_SPOT`                                  | Whether to launch workers as EC2 Spot instances (`true`/`false`)    | `true`                        |
| `EC2_IAM_INSTANCE_PROFILE`                      | IAM instance profile attached to worker instances                   | `VeoLMSWorkerInstanceProfile` |
| `S3_BUCKET`                                     | S3 bucket containing worker bundles and video outputs               | _Required_                    |
| `AMI_ID`                                        | Optional pre-baked AMI ID (bypasses dynamic Debian SSM lookup)      | _Optional_                    |
| `SUBNET_ID`                                     | Optional target subnet ID for EC2 launches                          | _Optional_                    |
| `SECURITY_GROUP_IDS` / `EC2_SECURITY_GROUP_IDS` | Comma-separated list of Security Group IDs                          | _Optional_                    |
| `KEY_NAME` / `EC2_KEY_NAME`                     | Optional EC2 KeyPair name for SSH debugging                         | _Optional_                    |
| `LAMBDA_FUNCTION_ARN`                           | ARN of the Fleet Manager Lambda (used by EventBridge Scheduler)     | _Optional_                    |
| `SCHEDULER_ROLE_ARN`                            | IAM Role ARN allowing EventBridge Scheduler to invoke Lambda        | _Optional_                    |

---

## Infrastructure Provisioning & Teardown

```bash
# Select AWS (option 1); the next command starts Floci automatically
pnpm run fleet:provider

# Choose Floci in the infra wizard; it uses DATABASE_URL from the root .env
pnpm run fleet:infra

# Interactive setup: provisions IAM roles, profiles, S3 bucket permissions, log groups, and builds bundles
pnpm fleet:infra --target=floci --endpoint=http://localhost:4566

# Build custom pre-baked AMI for instant boot times
pnpm fleet:build-ami

# Queue and trigger end-to-end transcode task
pnpm fleet:queue:trigger --provider=aws --key=raw/video.mp4 --qty=240p

# Teardown: safely terminates instances, deletes Lambda, log groups, and IAM roles
pnpm fleet:destroy --provider=aws

# Remove Floci/PostgreSQL/local fleet containers and images after a test
pnpm run fleet:docker:clean
```

The Floci setup uses the AWS provider with `AWS_ENDPOINT_URL` and deterministic
`test` credentials. Floci maps the `ami-debian12` EC2 image alias to a
Docker image, executes EC2 `UserData` in a real Docker container, and injects
`AWS_ENDPOINT_URL=http://floci:4566` into Lambda/EC2 containers. The generated
host-side `.env` files use `http://localhost:4566`; do not copy that host URL
into a spawned Lambda or EC2 container. The root hosted `DATABASE_URL` is
reused inside those containers; this setup does not start PostgreSQL.

To keep the production path unchanged, choose **AWS cloud** at the first
`pnpm fleet:infra` prompt (or pass `--target=aws`). The AWS branch still uses
the normal AWS credential/profile chain, dynamic AMI resolution, and Spot or
On-Demand selection.

---

## Running Tests

```bash
pnpm --filter @veolms/fleet-provider-aws test
pnpm --filter @veolms/fleet-provider-aws typecheck
```
