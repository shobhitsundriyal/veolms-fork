FROM node:24-bookworm-slim

ARG TARGETARCH

# Install system dependencies required for video transcoding
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy pre-bundled standalone worker script
COPY dist/media-worker.js ./worker.js

# sharp is a native module. The bundle intentionally leaves it external so
# npm can install the binary matching the image's target architecture rather
# than accidentally embedding the build host's binary (or no binary at all).
RUN target_arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "$target_arch" in \
      arm64) sharp_cpu="arm64" ;; \
      amd64|x86_64) sharp_cpu="x64" ;; \
      *) echo "Unsupported Docker target architecture: $target_arch" >&2; exit 1 ;; \
    esac \
    && npm install --prefix /app --no-save --no-package-lock --no-audit --no-fund \
      --omit=dev --include=optional --os=linux --cpu="$sharp_cpu" sharp@0.34.5 \
    && node -e "require('/app/node_modules/sharp')"

CMD ["node", "worker.js"]
