/*
 * Cloudflare Worker configuration
 *
 * R2 binding (configured in wrangler.cdn.jsonc):
 * - MEDIA_BUCKET: private R2 bucket exposed through env.MEDIA_BUCKET.
 *
 * Shared CDN environment variable:
 * - CDN_URL: absolute CDN/Worker URL or same-origin path such as /cdn. The
 *   Worker derives its route prefix from this value.
 *
 * Worker environment variables (env):
 * - CDN_SIGNING_SECRET: secret shared with the API for veo_token HMAC checks.
 * - CDN_PUBLIC_FOLDERS: comma-separated public R2 folders.
 * - CDN_PRIVATE_FOLDERS: comma-separated folders requiring veo_token.
 * - CORS_ORIGINS: comma-separated allowed browser origins, or *.
 *
 * API-side token variables:
 * - CDN_TOKEN_TTL_SECONDS: normal protected-media token lifetime.
 * - CDN_HLS_TOKEN_TTL_SECONDS: protected HLS segment token lifetime.
 */

const TOKEN_QUERY_PARAMETER = "veo_token";
const MANIFEST_PATTERN = /\.m3u8$/iu;
const DEFAULT_CDN_URL = "/cdn";
const DEFAULT_PUBLIC_FOLDERS = ["public", "course-hls", "course-videos"];
const DEFAULT_PRIVATE_FOLDERS = ["protected", "media", "transcoded"];
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export default {
  async fetch(request, env, context) {
    const method = request.method.toUpperCase();
    if (method === "OPTIONS") {
      return createOptionsResponse(request, env);
    }
    if (method !== "GET" && method !== "HEAD") {
      return createErrorResponse(
        request,
        env,
        405,
        "METHOD_NOT_ALLOWED",
        "Only GET, HEAD, and OPTIONS are supported.",
        { Allow: "GET, HEAD, OPTIONS" },
      );
    }

    const objectKey = getObjectKey(request, env);
    if (!objectKey) {
      return createErrorResponse(
        request,
        env,
        400,
        "INVALID_MEDIA_PATH",
        "The media path is invalid.",
      );
    }

    const visibility = classifyObjectKey(objectKey, env);
    if (visibility === "unknown") {
      return createErrorResponse(request, env, 404, "NOT_FOUND", "Not found.");
    }

    if (visibility === "protected") {
      const token = new URL(request.url).searchParams.get(
        TOKEN_QUERY_PARAMETER,
      );
      if (
        !env.CDN_SIGNING_SECRET ||
        !token ||
        !(await verifyAccessToken(token, objectKey, env.CDN_SIGNING_SECRET))
      ) {
        return createErrorResponse(
          request,
          env,
          401,
          "MEDIA_TOKEN_REQUIRED",
          "A valid media token is required.",
        );
      }
    }

    const rangeHeader = request.headers.get("Range");
    const hasConditionalHeaders = Boolean(
      request.headers.get("If-None-Match") ||
      request.headers.get("If-Modified-Since"),
    );
    const canUseSharedCache =
      method === "GET" &&
      !rangeHeader &&
      !hasConditionalHeaders &&
      isWildcardCors(env);
    const cacheKey = canUseSharedCache ? createCacheKey(request) : undefined;

    if (cacheKey) {
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
    }

    let object;
    let range;
    let metadata;

    if (rangeHeader || method === "HEAD" || hasConditionalHeaders) {
      metadata = await env.MEDIA_BUCKET.head(objectKey);
      if (!metadata) {
        return createErrorResponse(
          request,
          env,
          404,
          "NOT_FOUND",
          "Not found.",
        );
      }

      const notModified = isNotModified(request, metadata);
      if (notModified) {
        return createNotModifiedResponse(request, env, objectKey, metadata);
      }

      if (method === "HEAD") {
        return createObjectResponse(
          request,
          env,
          objectKey,
          metadata,
          null,
          null,
          "HEAD",
        );
      }

      if (rangeHeader) {
        range = parseRange(rangeHeader, metadata.size);
        if (!range) {
          return createErrorResponse(
            request,
            env,
            416,
            "RANGE_NOT_SATISFIABLE",
            "The requested byte range is invalid.",
            { "Content-Range": `bytes */${metadata.size}` },
          );
        }
        object = await env.MEDIA_BUCKET.get(objectKey, {
          range: { offset: range.start, length: range.length },
        });
      } else {
        object = await env.MEDIA_BUCKET.get(objectKey);
      }
    } else {
      object = await env.MEDIA_BUCKET.get(objectKey);
    }

    if (!object) {
      return createErrorResponse(request, env, 404, "NOT_FOUND", "Not found.");
    }

    const response = createObjectResponse(
      request,
      env,
      objectKey,
      object,
      range,
      metadata,
      method,
    );

    if (cacheKey && response.ok) {
      context.waitUntil(caches.default.put(cacheKey, response.clone()));
    }
    return response;
  },
};

function getObjectKey(request, env) {
  const url = new URL(request.url);
  const configuredPrefix = getCdnPathPrefix(env.CDN_URL);
  let pathname = url.pathname;

  if (
    configuredPrefix &&
    (pathname === configuredPrefix ||
      pathname.startsWith(`${configuredPrefix}/`))
  ) {
    pathname = pathname.slice(configuredPrefix.length);
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (!decodedPath.startsWith("/") || decodedPath.includes("\0")) {
    return null;
  }

  const parts = decodedPath.split("/").slice(1);
  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\\") ||
        part.includes("\0"),
    )
  ) {
    return null;
  }

  return parts.join("/");
}

function getCdnPathPrefix(value) {
  const configuredUrl = String(value || DEFAULT_CDN_URL).trim();
  if (/^\/(?!\/)/u.test(configuredUrl)) {
    return normalizePathPrefix(configuredUrl);
  }

  try {
    return normalizePathPrefix(new URL(configuredUrl).pathname);
  } catch {
    return normalizePathPrefix(DEFAULT_CDN_URL);
  }
}

function classifyObjectKey(objectKey, env) {
  if (MANIFEST_PATTERN.test(objectKey)) return "public";

  const privateFolders = parseFolderList(
    env.CDN_PRIVATE_FOLDERS,
    DEFAULT_PRIVATE_FOLDERS,
  );
  if (matchesFolder(objectKey, privateFolders)) return "protected";

  const publicFolders = parseFolderList(
    env.CDN_PUBLIC_FOLDERS,
    DEFAULT_PUBLIC_FOLDERS,
  );
  if (matchesFolder(objectKey, publicFolders)) return "public";

  return "unknown";
}

function parseFolderList(value, fallback) {
  const folders = String(value || "")
    .split(",")
    .map((folder) => folder.trim().replace(/^\/+|\/+$/gu, ""))
    .filter(Boolean);
  return folders.length > 0 ? folders : fallback;
}

function matchesFolder(objectKey, folders) {
  return folders.some(
    (folder) => objectKey === folder || objectKey.startsWith(`${folder}/`),
  );
}

function normalizePathPrefix(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") return "";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/u, "");
}

async function verifyAccessToken(token, objectKey, secret) {
  if (typeof token !== "string" || token.length > 4096) return false;

  const separator = token.indexOf(".");
  if (separator <= 0 || separator !== token.lastIndexOf(".")) return false;

  const payloadPart = token.slice(0, separator);
  const signaturePart = token.slice(separator + 1);
  let payloadBytes;
  let signatureBytes;
  try {
    payloadBytes = decodeBase64Url(payloadPart);
    signatureBytes = decodeBase64Url(signaturePart);
  } catch {
    return false;
  }

  let payload;
  try {
    payload = JSON.parse(textDecoder.decode(payloadBytes));
  } catch {
    return false;
  }

  const tokenKey = normalizeTokenKey(payload?.k);
  if (
    payload?.v !== 1 ||
    !tokenKey ||
    !Number.isInteger(payload?.e) ||
    payload.e <= Math.floor(Date.now() / 1000) ||
    !(objectKey === tokenKey || objectKey.startsWith(`${tokenKey}/`))
  ) {
    return false;
  }

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      textEncoder.encode(String(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "HMAC",
      cryptoKey,
      signatureBytes,
      textEncoder.encode(payloadPart),
    );
  } catch {
    return false;
  }
}

function normalizeTokenKey(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/^\/+|\/+$/gu, "");
  if (
    !normalized ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return null;
  }
  return normalized;
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Invalid base64url value");
  }
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    if (start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }

  const length = end - start + 1;
  return length > 0 ? { start, end, length } : null;
}

function isNotModified(request, metadata) {
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch) {
    if (ifNoneMatch.trim() === "*") return true;
    const etag = metadata.httpEtag;
    if (
      etag &&
      ifNoneMatch.split(",").some((candidate) => etagMatches(candidate, etag))
    ) {
      return true;
    }
    return false;
  }

  const ifModifiedSince = request.headers.get("If-Modified-Since");
  if (!ifModifiedSince || !metadata.uploaded) return false;
  const timestamp = Date.parse(ifModifiedSince);
  return Number.isFinite(timestamp) && metadata.uploaded.getTime() <= timestamp;
}

function etagMatches(candidate, etag) {
  return candidate.trim().replace(/^W\//u, "") === etag.replace(/^W\//u, "");
}

function createObjectResponse(
  request,
  env,
  objectKey,
  object,
  range,
  metadata,
  method,
) {
  const headers = createObjectHeaders(
    request,
    env,
    objectKey,
    object,
    range,
    metadata,
  );
  const status = range ? 206 : 200;
  const body = method === "HEAD" ? null : object.body;
  return new Response(body, { status, headers });
}

function createObjectHeaders(request, env, objectKey, object, range, metadata) {
  const headers = new Headers();
  if (typeof object.writeHttpMetadata === "function") {
    object.writeHttpMetadata(headers);
  }

  if (!headers.get("Content-Type")) {
    headers.set("Content-Type", inferContentType(objectKey));
  }
  if (object.httpEtag || metadata?.httpEtag) {
    headers.set("ETag", object.httpEtag || metadata.httpEtag);
  }
  if (object.uploaded || metadata?.uploaded) {
    headers.set(
      "Last-Modified",
      (object.uploaded || metadata.uploaded).toUTCString(),
    );
  }

  const totalSize = metadata?.size ?? object.size ?? 0;
  const contentLength = range ? range.length : totalSize;
  headers.set("Content-Length", String(contentLength));
  headers.set("Accept-Ranges", "bytes");
  if (range) {
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${totalSize}`,
    );
  }

  headers.set("Cache-Control", cacheControlForKey(objectKey));
  headers.set("X-Content-Type-Options", "nosniff");
  addCorsHeaders(headers, request, env);
  return headers;
}

function cacheControlForKey(objectKey) {
  if (MANIFEST_PATTERN.test(objectKey)) {
    return "public, max-age=60, s-maxage=60, stale-while-revalidate=300";
  }
  if (/\.(?:m4s|ts|aac|mp4|webm|m4a)$/iu.test(objectKey)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600, s-maxage=3600";
}

function inferContentType(objectKey) {
  const extension = objectKey.slice(objectKey.lastIndexOf(".")).toLowerCase();
  return (
    {
      ".m3u8": "application/vnd.apple.mpegurl",
      ".m4s": "video/iso.segment",
      ".ts": "video/mp2t",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".m4a": "audio/mp4",
      ".aac": "audio/aac",
      ".vtt": "text/vtt; charset=utf-8",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".avif": "image/avif",
    }[extension] || "application/octet-stream"
  );
}

function createNotModifiedResponse(request, env, objectKey, metadata) {
  const headers = createObjectHeaders(
    request,
    env,
    objectKey,
    metadata,
    null,
    metadata,
  );
  headers.delete("Content-Length");
  headers.delete("Content-Range");
  return new Response(null, { status: 304, headers });
}

function createOptionsResponse(request, env) {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers":
      "Accept, Content-Type, If-Modified-Since, If-None-Match, Range",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "public, max-age=86400",
  });
  addCorsHeaders(headers, request, env);
  return new Response(null, { status: 204, headers });
}

function createErrorResponse(
  request,
  env,
  status,
  code,
  message,
  extraHeaders,
) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  addCorsHeaders(headers, request, env);
  return new Response(JSON.stringify({ success: false, code, message }), {
    status,
    headers,
  });
}

function addCorsHeaders(headers, request, env) {
  headers.set(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified",
  );
  const origin = request.headers.get("Origin");
  const allowedOrigins = parseCorsOrigins(env.CORS_ORIGINS);
  if (allowedOrigins.includes("*")) {
    headers.set("Access-Control-Allow-Origin", "*");
    return;
  }
  if (origin && allowedOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    const vary = headers.get("Vary");
    headers.set("Vary", vary ? `${vary}, Origin` : "Origin");
  }
}

function parseCorsOrigins(value) {
  const origins = String(value || "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : ["*"];
}

function isWildcardCors(env) {
  return parseCorsOrigins(env.CORS_ORIGINS).includes("*");
}

function createCacheKey(request) {
  const url = new URL(request.url);
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}
