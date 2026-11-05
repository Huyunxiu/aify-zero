/**
 * `GET /api/workspace/file`：把工作区里的一个文件按字节发出去。
 *
 * 和 RPC 分开，是因为它要服务三类调用方：`<img src>`、下载/另存、PDF 之类
 * 浏览器自己会渲染的二进制。带版本号的地址长缓存，不带版本号的先跳转一次，
 * 这样文件一改，地址就变，不需要任何缓存失效逻辑。
 *
 * 这是传输适配器：入参是 `Request`，出参是 `Response`。读逻辑在 `workspace.files.ts`。
 */
import { extname } from "node:path";

import { ApiError } from "../../errors";
import { readFileBytes } from "./workspace.files";
import { resolveRegularFile, versionOf } from "./workspace.paths";
import type { WorkspaceRoots } from "./workspace.paths";

/** 路由只依赖「会话 → 根」这一步，测试可以注入自己的实现。 */
export interface WorkspaceFileRouteDeps {
  readonly resolveRoots: (sessionId: string) => Promise<WorkspaceRoots>;
}

/**
 * 扩展名到 MIME 的映射。
 *
 * 只覆盖预览和下载会遇到的类型：认不出的扩展名一律
 * `application/octet-stream`，让浏览器下载而不是猜着渲染。不引入
 * `mime-types`，避免为一个查表加依赖。
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

/** 一个路径对应的 MIME；认不出时按二进制流处理。 */
function mimeOf(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

const BASE_HEADERS = {
  // HTML 与 SVG 可能被直接打开在 API 源上，别让浏览器猜类型或执行脚本。
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
} as const;

const NO_STORE = { ...BASE_HEADERS, "Cache-Control": "private, no-store" };

// 带版本号的地址只对应一个文件版本，内容不会再变。
const VERSIONED = {
  ...BASE_HEADERS,
  "Cache-Control": "private, max-age=31536000, immutable",
};

function fail(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: NO_STORE });
}

/**
 * 处理一次文件请求。
 *
 * @param request - 原始请求；只读查询参数，不读 body。
 * @param deps - 会话到根的解析函数。
 * @returns 跳转、文件内容，或一个带错误码的 JSON。
 */
export async function serveWorkspaceFile(
  request: Request,
  deps: WorkspaceFileRouteDeps
): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const path = url.searchParams.get("path") ?? "";

  if (sessionId === "" || path === "") {
    return fail(400, "missing sessionId or path");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return fail(405, "method not allowed");
  }

  try {
    const workspace = await deps.resolveRoots(sessionId);
    const target = await resolveRegularFile(workspace, path);
    const version = versionOf(target.fileInfo);

    if (url.searchParams.get("v") !== version) {
      // 相对地址，部署前缀和桌面自定义协议都能沿用。
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
      request.method === "HEAD" ? null : await readFileBytes(workspace, path);
    const headers = {
      ...VERSIONED,
      "Content-Type": mimeOf(target.realPath),
      // HEAD 只需要长度，不必把内容读出来；两者都以目标当前的元数据为准。
      "Content-Length": String(
        file === null ? target.fileInfo.size : file.data.byteLength
      ),
    };
    return new Response(file === null ? null : file.data, { headers });
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      return fail(error.status, error.code);
    }
    throw error;
  }
}
