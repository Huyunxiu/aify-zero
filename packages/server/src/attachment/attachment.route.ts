/**
 * The attachment byte channel: `GET /api/attachment?owner=session:<id>&sha256=<hex>`.
 *
 * A read records an immutable reference, and this route turns that reference back into
 * bytes for the interface. It is not the asset route: an asset name can change under a
 * fixed address, so assets are served with a version redirect. An attachment address
 * names one set of bytes forever, so the response can be cached as immutable.
 *
 * The digest is the whole address. It is validated as hexadecimal before it reaches
 * the filesystem, so a reference can never name a path outside the owner's directory.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isAttachmentDigest } from "@workspace/agent-client";
import type { Hono } from "hono";

import { parseAssetOwner } from "../asset/asset-owners";
import { getSessionDir } from "../config";
import { failureResponse } from "../file-response";
import type { HonoEnv } from "../hono-env";

const IMMUTABLE = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
  "Cache-Control": "private, max-age=31536000, immutable",
} as const;

/** Whether the RIFF container declares WebP, and not some other RIFF format. */
function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

/** The media type of stored bytes, from their signature. */
function mediaTypeOf(bytes: Uint8Array): string {
  const starts = (...values: number[]): boolean =>
    values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47)) {
    return "image/png";
  }
  if (starts(0xff, 0xd8, 0xff)) {
    return "image/jpeg";
  }
  if (starts(0x47, 0x49, 0x46, 0x38)) {
    return "image/gif";
  }
  if (starts(0x52, 0x49, 0x46, 0x46) && isWebp(bytes)) {
    return "image/webp";
  }
  if (starts(0x25, 0x50, 0x44, 0x46)) {
    return "application/pdf";
  }
  return "application/octet-stream";
}

/** Register the attachment channel, after authentication and before the RPC fallback. */
export function registerAttachmentRoutes(app: Hono<HonoEnv>): void {
  app.get("/api/attachment", async (c) => {
    const query = new URL(c.req.url).searchParams;
    const owner = parseAssetOwner(query.get("owner") ?? "");
    const sha256 = query.get("sha256") ?? "";

    if (
      owner === null ||
      owner.kind !== "session" ||
      !isAttachmentDigest(sha256)
    ) {
      return failureResponse(400, "invalid attachment address");
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(
        await readFile(join(getSessionDir(owner.id), "attachments", sha256))
      );
    } catch {
      return failureResponse(404, "attachment not found");
    }

    return new Response(
      c.req.method === "HEAD" ? null : new Uint8Array(bytes),
      {
        headers: {
          ...IMMUTABLE,
          "Content-Type": mediaTypeOf(bytes),
          "Content-Length": String(bytes.byteLength),
        },
      }
    );
  });
}
