/**
 * The byte outlet for one file: the path gate, the versioned redirect, the cache
 * headers, and the MIME table.
 *
 * Two routes share it: `/api/workspace/file` sends files from a session workspace, and
 * `/api/asset` sends files from an owner's asset directory. They differ only in where
 * the root comes from, so how bytes travel lives here once.
 */
import { extname } from "node:path";

import { ApiError } from "./errors";
import { readFileBytes } from "./routers/workspace/workspace.files";
import {
  resolveRegularFile,
  versionOf,
} from "./routers/workspace/workspace.paths";
import type { WorkspaceRoots } from "./routers/workspace/workspace.paths";

/**
 * Extension to MIME. Only the types preview and download meet; an unknown extension
 * becomes `application/octet-stream`, so the browser downloads instead of guessing. No
 * `mime-types` dependency: one lookup table is not worth a package.
 */
const MIME_TYPES: Record<string, string> = {
  ".bmp": "image/bmp",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** The MIME of one path; an unknown extension is a byte stream. */
function mimeOf(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

const BASE_HEADERS = {
  // HTML and SVG can be opened on the API origin: do not let the browser guess the
  // type or run a script.
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
} as const;

const NO_STORE = { ...BASE_HEADERS, "Cache-Control": "private, no-store" };

// A versioned address names one version of a file, whose content cannot change again.
const VERSIONED = {
  ...BASE_HEADERS,
  "Cache-Control": "private, max-age=31536000, immutable",
};

/** A byte-outlet failure: the error code, with headers that forbid caching. */
export function failureResponse(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: NO_STORE });
}

/**
 * Send one file from inside a root as bytes.
 *
 * An address without a version first redirects to the same address with `v=`: a file
 * change moves the version, so caching needs no invalidation. An `ApiError` becomes a
 * JSON error code; anything else keeps climbing.
 *
 * @param request - The raw request; only query parameters are read, never the body.
 * @param roots - The roots this request may read, the first one being the base.
 * @param path - A path relative to the base root.
 * @returns A redirect, the file content, or a JSON error code.
 */
export async function serveVersionedFile(
  request: Request,
  roots: WorkspaceRoots,
  path: string
): Promise<Response> {
  const url = new URL(request.url);

  try {
    const target = await resolveRegularFile(roots, path);
    const version = versionOf(target.fileInfo);

    if (url.searchParams.get("v") !== version) {
      // A relative address, so a deployment prefix and the desktop protocol survive.
      const location = new URL(url);
      location.searchParams.set("v", version);
      return new Response(null, {
        status: 302,
        headers: {
          ...NO_STORE,
          Location: `${location.pathname}${location.search}`,
        },
      });
    }

    const file =
      request.method === "HEAD" ? null : await readFileBytes(roots, path);
    const headers = {
      ...VERSIONED,
      "Content-Type": mimeOf(target.realPath),
      // HEAD needs the length only, so the content stays unread; both take the length
      // from the target's current metadata.
      "Content-Length": String(
        file === null ? target.fileInfo.size : file.data.byteLength
      ),
    };
    return new Response(file === null ? null : file.data, { headers });
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      return failureResponse(error.status, error.code);
    }
    throw error;
  }
}
