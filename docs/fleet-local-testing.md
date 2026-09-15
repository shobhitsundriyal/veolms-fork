# Local Fleet Testing

The repository supports two local Docker-backed workflows. The `docker`
provider is the serverful container workflow described below. The `aws`
provider can run against Floci, which emulates the AWS control plane locally
and launches Lambda/EC2 workloads as Docker containers. Both require Docker.
Normal development stays lightweight: `docker compose up -d` starts only
PostgreSQL. The AWS-provider workflow starts only `compose.floci.yaml` from
inside `pnpm run fleet:infra`; the Fleet commands read the generated
`apps/fleet-manager/.env` and `apps/media-worker/.env` files directly, along
with the current process environment.

## Files and lifecycle

| File / command                   | Purpose                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `compose.yaml`                   | Normal development services: PostgreSQL only.                                          |
| `compose.floci.yaml`             | Floci AWS emulator with persistent storage and Docker socket access.                   |
| `compose.fleet.yaml`             | Optional serverful Docker Fleet Manager service.                                       |
| `pnpm run fleet:provider`        | Interactive CLI to select active provider (docker, aws, local).                        |
| `pnpm run fleet:infra`           | Starts Floci when selected, prompts for config, and provisions AWS-shaped resources.   |
| `pnpm run fleet:docker:clean`    | Removes Floci/PostgreSQL/local fleet containers and images; preserves persisted state. |
| `pnpm compose:floci:up`          | Optional manual Floci-only helper; it does not start PostgreSQL.                       |
| `pnpm compose:floci:down`        | Optional manual Floci-only stop helper.                                                |
| `pnpm fleet:infra --update`      | Automatically rebuilds bundles and updates Docker container images after code edits.   |
| `pnpm fleet:cli run daemon`      | Runs Fleet Manager in-process to poll and orchestrate Docker workers.                  |
| `pnpm fleet:destroy`             | Teardown CLI: choose between stopping running containers or complete teardown.         |
| `pnpm fleet:destroy --stop-only` | Gracefully stops running worker and manager containers; preserves data and images.     |

The manager image contains `fleet-manager.cjs`; the worker image contains
`media-worker.js`. Docker does not copy the complete repository or install
workspace dependencies during image startup.

`pnpm fleet:provider --provider=docker` detects the Docker socket group and
writes `DOCKER_SOCKET_GID` for you. On Linux, this is the group id reported by
`stat -c '%g' /var/run/docker.sock`; Docker Desktop maps the mounted socket to
group `0`. The Compose manager runs as the non-root `node` user and receives
only that socket group.

## AWS provider against Floci

Run the two Fleet commands. Selecting AWS in the provider command and Floci in
the infra wizard starts the local AWS-shaped control plane automatically:

```bash
pnpm run fleet:provider # choose AWS (option 1)
pnpm run fleet:infra # choose Floci at "Where should this provision resources?"
```

The Floci Compose flow uses the root `.env` for Docker Compose interpolation,
including `DATABASE_URL`. If that URL is hosted, the same URL is passed to
Floci Lambda/EC2 containers and no PostgreSQL container is started.

The wizard writes `FLOCI_ENDPOINT`/`AWS_ENDPOINT_URL` to the generated app env
files for host-side calls and uses `test` credentials. Floci's Compose
hostname is `floci`, so spawned Lambda and EC2 containers receive a reachable
`http://floci:4566` endpoint.
The wizard creates the AWS-shaped IAM, S3, Lambda, EC2 security-group,
EventBridge Scheduler, and CloudWatch Logs resources inside Floci only; it
does not use an AWS profile or make cloud calls. Use `--target=aws` when you
intentionally want the existing production AWS path.

## Serverful daemon

```bash
pnpm fleet:provider # select Docker interactively
pnpm fleet:infra    # configures env, migrates database, builds worker & manager images
pnpm fleet:cli run daemon  # starts fleet manager (or run containerized via docker compose)
pnpm fleet:cli queue raw/video.mp4 --qualities=240p
pnpm fleet:cli workers
```

`fleet-manager` runs continuously in Compose. Every claimed job starts a
`veolms-media-worker:local` container with `WORKER_MAX_JOBS=1`; it exits after
the job and the manager removes it. Input and HLS output are in `s3-bucket/`.
Both images copy only their prebuilt JavaScript bundle, not the full workspace
or `node_modules`.

### Database records written by a worker

Before FFmpeg starts, the worker probes (or reuses) the source metadata and
persists `width`, `height`, and the rounded `duration_seconds` on the
`media_assets` row referenced by `video_jobs.video_id`. After a successful HLS
transcode, it records the portable storage key
`<output_prefix>/master.m3u8` in `video_outputs.master_playlist_path` in the
same completion transaction. Repeated attempts update the existing output row
for that media asset instead of creating duplicate rows.

For a PostgreSQL server running on the Docker host, use
`host.docker.internal` in both URLs (for example,
`postgresql://veolms:veolms@host.docker.internal:5433/veolms`). The provider
adds the host-gateway mapping to every worker. No PostgreSQL container is
created by the Fleet commands.

To test a public URL:

```bash
pnpm fleet:cli queue 'https://example.com/video.mp4' \
  --qualities=240p --prefix=output/local-test/
pnpm fleet:cli test watch --job <job-id>
```

## Fault scenarios

Set `FLEET_TEST_MODE=true` (the Compose profiles do this). Once a worker is
created, trigger one of the guarded local-only scenarios:

```bash
pnpm fleet:cli test fault interrupt --worker <worker-id>
pnpm fleet:cli test fault heartbeat-loss --worker <worker-id>
pnpm fleet:cli test fault progress-stall --worker <worker-id>
pnpm fleet:cli test fault worker-failure --worker <worker-id>
pnpm fleet:cli test fault storage-failure --worker <worker-id>
pnpm fleet:cli test watch --job <job-id>
```

`interrupt` records its requested/applied audit events while leaving worker and
job state unchanged before termination. The normal fleet reconciliation and
retry path then remains visible in the job timeline.
