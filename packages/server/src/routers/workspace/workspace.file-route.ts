/**
 * `GET /api/workspace/file`: send one file of a session workspace as bytes.
 *
 * It is separate from RPC because three kinds of caller need it: `<img src>`, download
 * or save-as, and binaries the browser renders itself (PDF). A versioned address caches
 * for a year; an unversioned one redirects once, so changing a file changes its address
 * and no cache-invalidation logic exists.
 *
 * This is the transport adapter: a `Request` in, a `Response` out. Reading lives in
 * `workspace.files.ts`; how bytes travel lives in `file-response.ts`.
 */
import { ApiError } from "../../errors";
import { failureResponse, serveVersionedFile } from "../../file-response";
import type { WorkspaceRoots } from "./workspace.paths";

/** The route depends only on "session to roots", so a test can inject its own. */
export interface WorkspaceFileRouteDeps {
  readonly resolveRoots: (sessionId: string) => Promise<WorkspaceRoots>;
}

/**
 * Handle one workspace file request.
 *
 * @param request - The raw request; only query parameters are read, never the body.
 * @param deps - The session-to-roots resolver.
 * @returns A redirect, the file content, or a JSON error code.
 */
export async function serveWorkspaceFile(
  request: Request,
  deps: WorkspaceFileRouteDeps
): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const path = url.searchParams.get("path") ?? "";

  if (sessionId === "" || path === "") {
    return failureResponse(400, "missing sessionId or path");
  }
  let roots: WorkspaceRoots;
  try {
    roots = await deps.resolveRoots(sessionId);
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      return failureResponse(error.status, error.code);
    }
    throw error;
  }

  return await serveVersionedFile(request, roots, path);
}
