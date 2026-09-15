import type { WorkerSpec } from "@veolms/fleet-types";

export interface BootstrapperOptions {
  workerId: string;
  spec: WorkerSpec;
  repoUrl?: string;
  workerBundleS3Url?: string;
  extraEnv?: Readonly<Record<string, string>>;
}

export const DEFAULT_BOOTSTRAP_SCRIPT = `#!/bin/bash
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive

exec > >(tee -a /var/log/veolms-bootstrap.log) 2>&1
echo "[bootstrapper] Initializing VeoLMS Transcoder Worker: __WORKER_ID__ at \$(date)"

# Floci injects both variables into EC2 containers. In that local mode the
# S3 endpoint accepts the deterministic test credentials without requiring a
# 67 MB AWS CLI download; real AWS workers still install and use AWS CLI v2.
IS_FLOCI=false
if [ -n "\${AWS_EC2_METADATA_SERVICE_ENDPOINT:-}" ] && [ -n "\${AWS_ENDPOINT_URL:-}" ]; then
  IS_FLOCI=true
fi

cleanup_and_terminate() {
  local exit_code=\$?
  if [ "\$exit_code" -ne 0 ]; then
    echo "[bootstrapper] Bootstrap failed with exit code \$exit_code."
  fi

  local LOG_BUCKET="\${S3_BUILD_BUCKET:-\${BUCKET_NAME:-}}"
  if [ -n "\$LOG_BUCKET" ]; then
    if [ "\$IS_FLOCI" = "true" ]; then
      local FLOCI_S3_ENDPOINT="\${AWS_ENDPOINT_URL%/}"
      if [ -f /var/log/veolms-bootstrap.log ]; then
        curl -fsS --retry 2 -X PUT --data-binary @/var/log/veolms-bootstrap.log \\
          "\$FLOCI_S3_ENDPOINT/\$LOG_BUCKET/worker-logs/__WORKER_ID__/bootstrap.log" \\
          >/dev/null 2>&1 || true
      fi
      if [ -f /var/log/veolms-worker.log ]; then
        curl -fsS --retry 2 -X PUT --data-binary @/var/log/veolms-worker.log \\
          "\$FLOCI_S3_ENDPOINT/\$LOG_BUCKET/worker-logs/__WORKER_ID__/worker.log" \\
          >/dev/null 2>&1 || true
      fi
    elif command -v aws &> /dev/null; then
      if [ -f /var/log/veolms-bootstrap.log ]; then
        aws s3 cp /var/log/veolms-bootstrap.log \\
          "s3://\$LOG_BUCKET/worker-logs/__WORKER_ID__/bootstrap.log" \\
          --region "\${AWS_REGION:-us-east-2}" 2>/dev/null || true
      fi
      if [ -f /var/log/veolms-worker.log ]; then
        aws s3 cp /var/log/veolms-worker.log \\
          "s3://\$LOG_BUCKET/worker-logs/__WORKER_ID__/worker.log" \\
          --region "\${AWS_REGION:-us-east-2}" 2>/dev/null || true
      fi
    fi
  fi

  if [ "\$IS_FLOCI" = "true" ]; then
    echo "[bootstrapper] Floci owns the container lifecycle; skipping AWS instance termination."
  else
    echo "[bootstrapper] Terminating EC2 instance..."
    TOKEN=\$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)
    if [ -n "\$TOKEN" ]; then
      INSTANCE_ID=\$(curl -s -H "X-aws-ec2-metadata-token: \$TOKEN" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)
      INSTANCE_REGION=\$(curl -s -H "X-aws-ec2-metadata-token: \$TOKEN" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || true)
    else
      INSTANCE_ID=\$(curl -s http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)
      INSTANCE_REGION="\${AWS_REGION:-us-east-2}"
    fi

    if [ -n "\$INSTANCE_ID" ] && command -v aws &> /dev/null; then
      aws ec2 terminate-instances --instance-ids "\$INSTANCE_ID" --region "\${INSTANCE_REGION:-us-east-2}" || true
    fi
    if command -v shutdown &> /dev/null; then
      shutdown -h now || true
    fi
  fi
}
trap cleanup_and_terminate EXIT

wait_for_apt_locks() {
  local wait_start=\$(date +%s)
  while true; do
    local lock_held=false
    if command -v fuser &> /dev/null && fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1; then
      lock_held=true
    elif ps -eo args= 2>/dev/null | grep -Eq '(^|/)(apt|apt-get|dpkg)([[:space:]]|$)'; then
      # Minimal Ubuntu images do not always include fuser, but they do ship
      # ps. This fallback also covers a package process whose lock is held by
      # a helper that fuser cannot see yet.
      lock_held=true
    elif [ -d /proc ]; then
      # Debian/Ubuntu slim images may omit both fuser and procps. Floci's
      # asynchronous guest setup can still be found through procfs, so do not
      # race apt/dpkg when the normal tools are absent.
      local proc_dir proc_cmd
      for proc_dir in /proc/[0-9]*; do
        proc_cmd=\$(tr '\\000' ' ' < "\$proc_dir/cmdline" 2>/dev/null || true)
        case "\$proc_cmd" in
          *apt-get*|*'/usr/bin/apt '*|*'/usr/bin/apt'|*dpkg*|*dnf*|*yum*|*rpm*|*/usr/lib/apt/methods/*)
            lock_held=true
            break
            ;;
        esac
      done
    fi

    if [ "\$lock_held" != "true" ]; then
      return 0
    fi
    if [ \$(( \$(date +%s) - wait_start )) -gt 300 ]; then
      echo "[bootstrapper] Timed out waiting for another apt/dpkg process after 300s."
      return 1
    fi
    echo "[bootstrapper] Waiting for another apt/dpkg process to release its lock..."
    sleep 2
  done
}

stop_floci_package_installers() {
  if [ "\$IS_FLOCI" != "true" ] || [ ! -d /proc ]; then
    return 0
  fi

  # Floci runs IMDS and sshd package probes asynchronously. On minimal rpm
  # and apt images those probes can outlive Floci's bounded exec timeout and
  # keep the package-manager lock held while this UserData script starts.
  # Local Floci workers use direct endpoint calls and do not need those probes
  # to provide AWS credentials or lifecycle control, so stop only package
  # manager processes before installing the worker prerequisites.
  local proc_dir proc_pid proc_cmd
  for proc_dir in /proc/[0-9]*; do
    proc_pid=\${proc_dir##*/}
    [ "\$proc_pid" = "\$$" ] && continue
    [ -r "\$proc_dir/cmdline" ] || continue
    proc_cmd=\$(tr '\\000' ' ' < "\$proc_dir/cmdline" 2>/dev/null || true)
    case "\$proc_cmd" in
      *apt-get*|*'/usr/bin/apt '*|*'/usr/bin/apt'|*dpkg*|*dnf*|*yum*|*rpm*|*/usr/lib/apt/methods/*)
        kill -TERM "\$proc_pid" 2>/dev/null || true
        ;;
    esac
  done
  sleep 1
  for proc_dir in /proc/[0-9]*; do
    proc_pid=\${proc_dir##*/}
    [ "\$proc_pid" = "\$$" ] && continue
    [ -r "\$proc_dir/cmdline" ] || continue
    proc_cmd=\$(tr '\\000' ' ' < "\$proc_dir/cmdline" 2>/dev/null || true)
    case "\$proc_cmd" in
      *apt-get*|*'/usr/bin/apt '*|*'/usr/bin/apt'|*dpkg*|*dnf*|*yum*|*rpm*|*/usr/lib/apt/methods/*)
        kill -KILL "\$proc_pid" 2>/dev/null || true
        ;;
    esac
  done
}

apt_update_with_retry() {
  local attempt
  for attempt in 1 2 3; do
    wait_for_apt_locks
    if apt-get update -y; then
      return 0
    fi
    echo "[bootstrapper] apt-get update failed (attempt \$attempt/3); retrying..."
    sleep 2
  done
  return 1
}

apt_install_with_retry() {
  local attempt
  for attempt in 1 2 3; do
    wait_for_apt_locks
    if apt-get install -y --no-install-recommends "\$@"; then
      return 0
    fi
    echo "[bootstrapper] apt-get install failed (attempt \$attempt/3); retrying..."
    sleep 2
  done
  return 1
}

install_aws_cli() {
  if command -v aws &> /dev/null; then
    return 0
  fi

  local aws_cli_arch=""
  case "\$(uname -m)" in
    aarch64|arm64) aws_cli_arch="aarch64" ;;
    x86_64|amd64) aws_cli_arch="x86_64" ;;
    *)
      echo "[bootstrapper] Unsupported architecture for AWS CLI: \$(uname -m)"
      return 1
      ;;
  esac

  echo "[bootstrapper] Installing AWS CLI v2 for \$aws_cli_arch..."
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-\$aws_cli_arch.zip" -o /tmp/awscliv2.zip
  rm -rf /tmp/aws
  unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install --update --install-dir /usr/local/aws-cli --bin-dir /usr/local/bin
  rm -rf /tmp/aws /tmp/awscliv2.zip
}

install_static_ffmpeg() {
  if command -v ffmpeg &> /dev/null && command -v ffprobe &> /dev/null; then
    return 0
  fi

  local ffmpeg_arch=""
  case "\$(uname -m)" in
    aarch64|arm64) ffmpeg_arch="arm64" ;;
    x86_64|amd64) ffmpeg_arch="amd64" ;;
    *)
      echo "[bootstrapper] Unsupported architecture for static FFmpeg: \$(uname -m)"
      return 1
      ;;
  esac

  local ffmpeg_url="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-\$ffmpeg_arch-static.tar.xz"
  local ffmpeg_archive="/tmp/ffmpeg-static.tar.xz"
  local ffmpeg_checksum="/tmp/ffmpeg-static.tar.xz.md5"
  local ffmpeg_extract_dir="/tmp/ffmpeg-static"

  echo "[bootstrapper] Installing static FFmpeg for \$ffmpeg_arch..."
  curl -fL --retry 3 --retry-delay 2 "\$ffmpeg_url" -o "\$ffmpeg_archive"
  curl -fL --retry 3 --retry-delay 2 "\$ffmpeg_url.md5" -o "\$ffmpeg_checksum"

  local expected_checksum=""
  local actual_checksum=""
  expected_checksum=\$(awk '{print \$1}' "\$ffmpeg_checksum")
  actual_checksum=\$(md5sum "\$ffmpeg_archive" | awk '{print \$1}')
  if [ -z "\$expected_checksum" ] || [ "\$expected_checksum" != "\$actual_checksum" ]; then
    echo "[bootstrapper] Static FFmpeg checksum verification failed."
    return 1
  fi

  rm -rf "\$ffmpeg_extract_dir"
  mkdir -p "\$ffmpeg_extract_dir"
  tar -xJf "\$ffmpeg_archive" -C "\$ffmpeg_extract_dir"

  local ffmpeg_binary=""
  local ffprobe_binary=""
  ffmpeg_binary=\$(find "\$ffmpeg_extract_dir" -type f -name ffmpeg -perm -u+x -print -quit)
  ffprobe_binary=\$(find "\$ffmpeg_extract_dir" -type f -name ffprobe -perm -u+x -print -quit)
  if [ -z "\$ffmpeg_binary" ] || [ -z "\$ffprobe_binary" ]; then
    echo "[bootstrapper] Static FFmpeg archive did not contain executable ffmpeg and ffprobe binaries."
    return 1
  fi

  install -m 0755 "\$ffmpeg_binary" /usr/local/bin/ffmpeg
  install -m 0755 "\$ffprobe_binary" /usr/local/bin/ffprobe
  rm -rf "\$ffmpeg_extract_dir" "\$ffmpeg_archive" "\$ffmpeg_checksum"
}

mkdir -p /opt/veolms
cat << 'EOF' > /opt/veolms/worker.env
__ENV_FILE_LINES__
EOF
chmod 600 /opt/veolms/worker.env

# Export environment variables for the current session
set -a
source /opt/veolms/worker.env
set +a

BUCKET_NAME="\${S3_BUCKET:-}"
BUILD_BUCKET="\${S3_BUILD_BUCKET:-\$BUCKET_NAME}"

set -e

# Install base dependencies if missing
NEEDS_AWS_CLI=false
if [ "\$IS_FLOCI" != "true" ] && ! command -v aws &> /dev/null; then
  NEEDS_AWS_CLI=true
fi
if ! command -v ffmpeg &> /dev/null || ! command -v node &> /dev/null || [ "\$NEEDS_AWS_CLI" = "true" ]; then
  echo "[bootstrapper] Installing prerequisites (curl, ca-certificates, FFmpeg)..."
  stop_floci_package_installers
  if command -v apt-get &> /dev/null; then
    # Disable automatic background daily upgrades that lock dpkg.
    systemctl stop apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service 2>/dev/null || true
    systemctl kill --kill-who=all apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
    apt_update_with_retry
    # Real AWS uses a self-contained static build below. Floci uses the
    # distro package instead so local workers stay on the fast Debian mirror
    # and do not spend their provisioning window downloading a large archive.
    apt_install_with_retry curl ca-certificates gnupg xz-utils findutils

    # Ubuntu's minimal repositories do not consistently carry the awscli
    # package. Install the official AWS CLI v2 bundle for real AWS workers;
    # Floci workers use its injected local S3 endpoint directly.
    if [ "\$NEEDS_AWS_CLI" = "true" ]; then
      apt_install_with_retry unzip
      install_aws_cli
    fi

    # Install Node.js 22 LTS if missing.
    if ! command -v node &> /dev/null; then
      echo "[bootstrapper] Installing Node.js 22 LTS..."
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt_install_with_retry nodejs
    fi
    if [ "\$IS_FLOCI" = "true" ]; then
      # The Floci Debian worker has access to the Debian mirror inside the
      # local test environment. Use its packaged ffmpeg/ffprobe pair here so
      # a local worker does not spend its provisioning window downloading a
      # large archive from an external mirror. Real AWS keeps the static path
      # below so it is independent of distro repositories.
      echo "[bootstrapper] Installing Debian FFmpeg package for Floci..."
      apt_install_with_retry ffmpeg
    else
      install_static_ffmpeg
    fi
  elif command -v dnf &> /dev/null; then
    # Amazon Linux ships curl-minimal. Do not request the full curl package;
    # dnf treats it as a conflicting replacement for the preinstalled tool.
    if ! command -v curl &> /dev/null; then
      dnf install -y curl
    fi
    dnf install -y ca-certificates xz tar findutils nodejs npm
    if [ "\$NEEDS_AWS_CLI" = "true" ]; then
      dnf install -y unzip
      install_aws_cli
    fi
    install_static_ffmpeg
  elif command -v yum &> /dev/null; then
    if ! command -v curl &> /dev/null; then
      yum install -y curl
    fi
    yum install -y ca-certificates xz tar findutils nodejs npm
    if [ "\$NEEDS_AWS_CLI" = "true" ]; then
      yum install -y unzip
      install_aws_cli
    fi
    install_static_ffmpeg
  else
    echo "[bootstrapper] Unsupported worker image: no apt-get, dnf, or yum found."
    exit 1
  fi
else
  echo "[bootstrapper] Pre-installed dependencies found (FFmpeg, Node.js, AWS CLI) — skipping package install."
fi

echo "[bootstrapper] System dependencies verified (node \$(node -v), ffmpeg \$(ffmpeg -version | head -n1))"

if [ -z "\$BUILD_BUCKET" ]; then
  echo "[bootstrapper] No S3 build bucket configured (S3_BUILD_BUCKET/S3_BUCKET) — cannot download worker bundle."
  exit 1
fi

echo "[bootstrapper] Downloading worker bundle from s3://\$BUILD_BUCKET/bundles/media-worker.js..."
if [ "\$IS_FLOCI" = "true" ]; then
  curl -fsSL --retry 3 --retry-delay 2 \\
    "\${AWS_ENDPOINT_URL%/}/\$BUILD_BUCKET/bundles/media-worker.js" \\
    -o /opt/veolms/worker.js
else
  aws s3 cp "s3://\$BUILD_BUCKET/bundles/media-worker.js" /opt/veolms/worker.js --region "\${AWS_REGION:-us-east-2}"
fi

if [ "\${IMAGE_WORKER_MODE:-false}" = "true" ]; then
  # sharp is a native dependency and the worker bundle leaves it external.
  # Install the binary for the architecture of this EC2 instance so both
  # fresh Debian boots and older pre-baked AMIs can run image jobs safely.
  SHARP_CPU=""
  case "\$(uname -m)" in
    aarch64|arm64) SHARP_CPU="arm64" ;;
    x86_64|amd64) SHARP_CPU="x64" ;;
    *)
      echo "[bootstrapper] Unsupported architecture for sharp: \$(uname -m)"
      exit 1
      ;;
  esac

  if ! (cd /opt/veolms && node -e 'require("sharp")') >/dev/null 2>&1; then
    if ! command -v npm >/dev/null 2>&1; then
      echo "[bootstrapper] npm is required to install sharp but was not found."
      exit 1
    fi
    echo "[bootstrapper] Installing sharp for Linux \$SHARP_CPU..."
    npm install --prefix /opt/veolms --no-save --no-package-lock --no-audit --no-fund --omit=dev --include=optional --os=linux --cpu="\$SHARP_CPU" sharp@0.34.5
  fi
  (cd /opt/veolms && node -e 'require("sharp")')
  echo "[bootstrapper] sharp runtime verified for Linux \$SHARP_CPU."
fi

echo "[bootstrapper] Launching VeoLMS Media Worker..."
cd /opt/veolms
node worker.js >> /var/log/veolms-worker.log 2>&1
echo "[bootstrapper] Worker run complete."
`;

export function getBootstrapScriptTemplate(): string {
  return DEFAULT_BOOTSTRAP_SCRIPT;
}

function escapeEnvValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/\r?\n/g, "\\n");
}

export function generateUserDataScript(options: BootstrapperOptions): string {
  const { workerId, spec, extraEnv } = options;

  const mergedEnv: Record<string, string> = {
    WORKER_ID: workerId,
    PROVIDER: "aws",
    ...spec.environmentVariables,
    ...extraEnv,
  };

  const envFileLines = Object.entries(mergedEnv)
    .map(([k, v]) => `${k}="${escapeEnvValue(v)}"`)
    .join("\n");

  return DEFAULT_BOOTSTRAP_SCRIPT.replaceAll(
    "__WORKER_ID__",
    workerId,
  ).replaceAll("__ENV_FILE_LINES__", envFileLines);
}

export function encodeUserDataBase64(script: string): string {
  return Buffer.from(script, "utf-8").toString("base64");
}
