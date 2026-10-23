import { readFile, realpath } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

import { APP_HOST, APP_ORIGIN } from "@workspace/shared/app-url";

/** 协议 handler 自己提供的 MIME，未列出的按二进制处理。 */
const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * 由前端 API 拥有的路由前缀。协议 handler 把它们交给同进程的 Hono，
 * 其余路径才按“文档”处理。
 */
const API_PREFIXES = ["/rpc", "/api-reference"] as const;

/**
 * Node 的 fetch 会解压响应体但保留这些头，Chromium 再解压一次就会白屏。
 * 其余是连接级 / 鉴权级头，不该穿过协议边界。
 */
const WITHHELD_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
];

export interface AppProtocolOptions {
  /** 生产：前端产物根目录；开发反代 Vite 时不需要。 */
  readonly webRoot?: string;
  /** 开发：把文档和静态资源请求转发给 Vite dev server。 */
  readonly devServerUrl?: string;
  /** 同进程 Hono，直接调用，不经过端口。 */
  readonly api: { fetch: (request: Request) => Promise<Response> | Response };
}

/**
 * 创建 `aify-app://` 的请求处理器。
 *
 * 分流顺序：API 前缀 -> 同进程 Hono；开发期 -> Vite；生产 -> 磁盘产物。
 *
 * @param options - 文档根目录、开发服务器和 API 入口。
 * @returns 满足 Electron `protocol.handle` 签名的处理函数。
 */
export const createAppProtocolHandler =
  (options: AppProtocolOptions) =>
  async (request: Request): Promise<Response> => {
    try {
      return await handleAppRequest(request, options);
    } catch (error) {
      console.error("[aify-app] protocol request failed", error);
      return new Response(null, { status: 500 });
    }
  };

const handleAppRequest = async (
  request: Request,
  options: AppProtocolOptions
): Promise<Response> => {
  const url = new URL(request.url);
  if (url.hostname !== APP_HOST) {
    return new Response(null, { status: 404 });
  }

  if (
    API_PREFIXES.some(
      (prefix) =>
        url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)
    )
  ) {
    return await forwardToApi(request, options.api);
  }

  if (options.devServerUrl !== undefined) {
    return await proxyToDevServer(request, options.devServerUrl);
  }

  if (options.webRoot === undefined) {
    return new Response(null, { status: 503 });
  }

  return await serveDocument(request, options.webRoot, url.pathname);
};

/**
 * 把应用来源的 API 请求交给同进程 Hono。同源、无端口、无 CORS，
 * 也不需要像跨进程 Host 那样交换 cookie。
 */
const forwardToApi = async (
  request: Request,
  api: AppProtocolOptions["api"]
): Promise<Response> => {
  const origin = request.headers.get("origin");
  // 同源请求通常不带 Origin：Chromium 对 aify-app://app/ 文档发出的同源
  // POST 实测也是 `null`(Electron 42)，所以缺省必须放行。带了 Origin 的
  // 只可能是别的文档在借道，必须精确等于应用源。
  if (origin !== null && origin !== APP_ORIGIN) {
    return new Response(null, { status: 403 });
  }

  // 自定义 scheme 不能直接改写成 http:（非 special -> special 不允许），
  // 这里重建一个普通的 http URL 交给 Hono，它只关心 pathname。
  const source = new URL(request.url);
  const target = `http://localhost${source.pathname}${source.search}`;

  const headers = new Headers(request.headers);
  headers.delete("host");

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit & { duplex: "half" } = {
    body: hasBody ? request.body : null,
    duplex: "half",
    headers,
    method: request.method,
    signal: request.signal,
  };

  return await api.fetch(new Request(target, init));
};

/**
 * 开发期把整个文档图转发给 Vite，保留 HMR 注入和模块转换。
 * HMR 的 WebSocket 由页面直接连 Vite，不经过这里。
 */
const proxyToDevServer = async (
  request: Request,
  devServerUrl: string
): Promise<Response> => {
  const source = new URL(request.url);
  const target = new URL(source.pathname + source.search, devServerUrl);

  const headers = new Headers(request.headers);
  // 让 undici 用目标地址写 Host，否则 Vite 的 allowedHosts 会 403。
  headers.delete("host");
  headers.delete("origin");
  headers.delete("cookie");
  headers.delete("sec-fetch-site");
  headers.delete("sec-fetch-mode");

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit & { duplex: "half" } = {
    body: hasBody ? request.body : null,
    duplex: "half",
    headers,
    method: request.method,
    redirect: "manual",
    signal: request.signal,
  };

  const upstream = await fetch(target, init);
  const responseHeaders = new Headers(upstream.headers);
  for (const name of WITHHELD_RESPONSE_HEADERS) {
    responseHeaders.delete(name);
  }

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    headers: responseHeaders,
    status: upstream.status,
  });
};

/**
 * 从磁盘提供文档：先找同名文件，找不到再按 SPA 规则回退到 index。
 */
const serveDocument = async (
  request: Request,
  root: string,
  pathname: string
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }

  const direct = await serveFile(
    request,
    root,
    pathname === "/" ? "/index.html" : pathname
  );
  if (direct.status !== 404) {
    return direct;
  }

  // 只有浏览器导航（Accept 含 text/html）才回退；缺资源继续 404。
  const acceptsHtml =
    request.headers.get("accept")?.includes("text/html") ?? false;
  if (request.method !== "GET" || !acceptsHtml) {
    return direct;
  }

  return await serveFile(request, root, "/index.html");
};

/** 把常见的文件系统错误收敛成能表达给 Chromium 的状态码。 */
const statusForFsError = (error: unknown): number | undefined => {
  const { code } = error as NodeJS.ErrnoException;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
    return 404;
  }
  if (code === "EACCES" || code === "EPERM") {
    return 403;
  }
  return undefined;
};

const serveFile = async (
  request: Request,
  root: string,
  pathname: string
): Promise<Response> => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (decoded.includes("\0")) {
    return new Response(null, { status: 400 });
  }

  const directory = resolve(root);
  const target = resolve(directory, `.${decoded}`);
  if (target !== directory && !target.startsWith(`${directory}${sep}`)) {
    return new Response(null, { status: 403 });
  }
  if (target === directory) {
    return new Response(null, { status: 404 });
  }

  // 上面的前缀校验只挡住了 `..`；根目录里的符号链接仍可能指向外面，
  // 所以再对真实路径做一次同样的校验。
  let file: string;
  let rootReal: string;
  try {
    [file, rootReal] = await Promise.all([
      realpath(target),
      realpath(directory),
    ]);
  } catch (error) {
    const status = statusForFsError(error);
    if (status === undefined) {
      throw error;
    }
    return new Response(null, { status });
  }
  if (file !== rootReal && !file.startsWith(`${rootReal}${sep}`)) {
    return new Response(null, { status: 403 });
  }
  if (file === rootReal) {
    return new Response(null, { status: 404 });
  }

  let body: Buffer;
  try {
    body = await readFile(file);
  } catch (error) {
    const status = statusForFsError(error);
    if (status === undefined) {
      throw error;
    }
    return new Response(null, { status });
  }

  // 只有带内容哈希的 assets/ 可以长缓存；favicon 之类的固定名字仍走校验。
  // 用解析后的相对路径判断，免得 `/assets/..%2Findex.html` 这类编码路径
  // 给 index 套上一年缓存。
  const immutable = relative(rootReal, file).split(sep)[0] === "assets";
  // Node 的 Buffer 与 DOM 的 BodyInit 类型不重合，但运行时就是字节。
  const payload =
    request.method === "HEAD" ? null : (body as unknown as BodyInit);
  return new Response(payload, {
    headers: {
      "cache-control": immutable
        ? "public, max-age=31536000, immutable"
        : "no-store",
      "content-type":
        MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    },
  });
};
