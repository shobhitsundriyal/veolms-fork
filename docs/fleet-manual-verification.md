# Fleet Manager — Manual Verification Runbook

Two commands, run in order, to manually provision infra and push a test job
through the pipeline. The default verification path is local Floci; the same
AWS provider can still be pointed at real AWS explicitly.

---

## 1. Provision infrastructure — provider, then infra

Run from the repo root:

```bash
pnpm run fleet:provider   # select AWS (option 1)
pnpm run fleet:infra      # select Floci in the infra wizard
```

It starts only the Floci control plane after you select Floci; PostgreSQL is
not started. The questions below appear after that. Press Enter to accept the
shown default.

| #         | Prompt                                 | What to answer                                                                                               |
| --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1         | Target Environment                     | `1` = Floci local emulator (free, Docker only) · `2` = AWS cloud (billed, explicit credentials)              |
| 1b        | Floci endpoint _(Floci only)_          | Default `http://localhost:4566`; spawned Lambda/EC2 containers use the Compose hostname `http://floci:4566`. |
| 2         | AWS region                             | e.g. `us-east-1`                                                                                             |
| preflight | Credentials check                      | Floci uses deterministic local test credentials; AWS uses the selected AWS profile/environment credentials.  |
| 3         | Fleet Manager Mode                     | `1` = Serverless (Lambda) · `2` = Serverful (daemon)                                                         |
| 4         | Lambda architecture _(serverless)_     | `1` = ARM64 · `2` = x86_64                                                                                   |
| 5         | Probe Lambda _(serverless)_            | `1` = Build/deploy ffprobe probe · `2` = Skip                                                                |
| 6         | Video Storage Provider                 | `1` = Local storage · `2` = S3; S3 is the default for Floci                                                  |
| 6a        | S3 buckets and credentials _(S3 only)_ | Choose private/public media access, a media bucket, a build bucket, and IAM/manual credentials.              |
| 7         | Fleet manager `DATABASE_URL`           | The hosted `DATABASE_URL` from the root `.env` is accepted and is used for PostgreSQL access.                |
| 7b        | Container database _(Floci only)_      | The hosted root URL is reused automatically; no local PostgreSQL container is needed.                        |
| 8         | Allowed EC2 instance types             | `1` = Balanced · `2` = Graviton wildcards · `3` = Unrestricted · `4` = Budget · `5` = Custom                 |
| 9         | EC2 Worker Boot Mode                   | Floci automatically uses fresh `ami-debian12`; AWS can use fresh install or a pre-baked AMI.         |
| 10        | SSH access                             | Floci/AWS can create or reuse the SSH security group.                                                        |
| 11        | SSH key pair                           | Optional; leave empty for SSM/console access.                                                                |
| 12        | Max concurrent workers                 | Default `8`.                                                                                                 |
| 13        | Worker idle poll interval (seconds)    | Default `15`; how long an idle worker waits before self-terminating.                                         |
| 14        | EC2 Pricing Model                      | Floci automatically uses on-demand API semantics; AWS offers Spot or On-Demand.                              |

**What it creates:** IAM role `VeoLMSWorkerRole` + instance profile
`VeoLMSWorkerInstanceProfile`, CloudWatch log groups `/veolms/workers` and
`/veolms/fleet-manager`, the `veolms-fleet-manager` Lambda (serverless mode),
an S3 bucket policy, and writes `apps/fleet-manager/.env` +
`apps/media-worker/.env`.

Re-running this command is safe — it reuses existing resources and
refreshes their policies/Lambda code+config rather than erroring.

**How capacity and idle workers actually behave:**

- `processNextJob()` checks the current count of non-terminal workers
  against `MAX_WORKERS` before claiming a job. At capacity, it declines and
  leaves the job `queued` for a later check — it will _not_ over-provision
  past the configured max.
- A worker doesn't die after a single job. When it finishes one, it checks
  the queue for the next `queued` job and claims it directly (atomically,
  same claim query the Lambda uses) — reusing the already-booted instance
  instead of paying the fresh-boot cost again. If the queue is empty, it
  waits `WORKER_IDLE_POLL_SECONDS`, checks exactly once more, and only then
  self-terminates.
- Because of that, freeing up a slot (a worker finishing) does **not** by
  itself pick up a different, still-blocked-on-capacity job — only the
  worker that just freed up looks for more work. A job that was declined at
  step "capacity check" still needs some Lambda invoke (e.g. another
  `fleet:queue:trigger`) to be claimed, unless a worker happens to poll and
  find it during its own idle-retry window.

### What was actually typed, this session (real AWS)

This transcript is from before the idle-poll-interval question (#11) was
added, so it only has 11 answers rather than the current 12 — everything
else about it is still accurate. In order, one answer per prompt — blank
means "pressed Enter to accept the shown default":

```
1                       # Target Environment -> Real AWS
us-east-1               # AWS region
                         # Fleet Manager Mode -> serverless (default)
                         # Storage Provider -> s3 (default)
veo-lms-test             # S3 bucket name
                         # S3 credential mode -> automatic (default)
                         # DATABASE_URL -> accepted default (Neon URL already in .env)
                         # Allowed instance types -> default (c7g.xlarge,c7g.2xlarge,c6i.xlarge)
1                       # EC2 Boot Mode -> fresh install
                         # Max concurrent workers -> default (8)
                         # Pricing model -> spot (default)
```

Result that run: reused the existing `VeoLMSWorkerRole` role/instance
profile/log groups, updated the existing `veolms-fleet-manager` Lambda's
code and env vars, reused the existing `veo-lms-test` bucket, uploaded the
worker bundle to it, and wrote both `.env` files.

For a local Floci run, choose `1` at prompt 1, accept
`http://localhost:4566`, use a disposable bucket such as
`veolms-floci-test`, and keep Spot disabled (the wizard does this
automatically for Floci). All SDK and CLI calls remain pinned to Floci.

---

## 2. Queue a transcode job — `pnpm fleet:queue:trigger`

Run from the repo root:

```bash
pnpm fleet:queue:trigger
```

Optional env vars:

| Var         | Default         | Notes                                                                                                                                       |
| ----------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `VIDEO_KEY` | `raw/video.mp4` | An S3 key relative to the bucket from step 1, **or** a full `http(s)://` URL — the worker downloads it directly instead of pulling from S3. |
| `QUALITIES` | `240p`          | Comma-separated, e.g. `240p,360p,720p`.                                                                                                     |

Example, using a short clip for a faster test run:

```bash
VIDEO_KEY=raw/video-1min.mp4 pnpm fleet:queue:trigger
```

`QUALITIES` defaults to `240p` only — the worked example below only
produced a `240p/` rendition for this reason. For multiple renditions in one
job:

```bash
VIDEO_KEY=raw/video-1min.mp4 QUALITIES=240p,360p,720p pnpm fleet:queue:trigger
```

**What it does:** inserts a `queued` row into the `jobs` table, then invokes
the `veolms-fleet-manager` Lambda once. The Lambda claims the **oldest**
`queued` job in the table (FIFO) — not necessarily the one just inserted, if
others are already waiting.

Check on it afterward:

```bash
pnpm fleet:cli status <job-id>   # printed by the trigger command
pnpm fleet:cli workers           # see the EC2 worker it launched
pnpm fleet:cli health            # cluster-wide summary
```

### What was actually run this session (real AWS)

```bash
pnpm fleet:queue:trigger --provider=aws --key=raw/video-1min.mp4 --qty=240p --yes
```

(run from the repo root; queues job in PostgreSQL and dispatches to AWS provider trigger)

Output:

```
[Queue] Adding job to database...
  Job ID:        ba55b585-1ea8-4d09-a7e4-e802425e9dbd
  Video Key:     raw/video-1min.mp4
  Output Prefix: hls/test-ba55b585/
  Qualities:     240p
✓ Job [ba55b585-1ea8-4d09-a7e4-e802425e9dbd] queued.

[Trigger] Invoking Lambda "veolms-fleet-manager"...
✓ Lambda invoked. Response: {"statusCode":200,"body":"{\"success\":true,\"jobClaimed\":true,...}"}

Check status: pnpm fleet:cli status ba55b585-1ea8-4d09-a7e4-e802425e9dbd
```

Because an older job was still `queued` ahead of it, that invocation
actually claimed and ran the older job (`c7d02a9a`, full-length
`raw/video.mp4`) — not `ba55b585` — which is the FIFO behavior noted above.
That run completed successfully end to end: worker created → booted →
FFmpeg transcoded 240p HLS → 91 segments + `master.m3u8` uploaded to
`s3://veo-lms-test/hls/test-c7d02a9a/` → job marked `completed` → EC2
instance self-terminated. Total wall time, worker creation to completion:
under 3 minutes.

---

## Tearing down

```bash
pnpm fleet:destroy
```

Terminates any active workers and deletes the Lambda, log groups, instance
profile, and IAM role. It will also prompt to delete the S3 bucket if it
still holds objects — read that prompt carefully if the bucket has anything
in it you didn't put there yourself. See
[fleet-commands-and-operations.md](./fleet-commands-and-operations.md) for
the full command reference.
