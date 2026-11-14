/**
 * OpenCode 网关（Zen 与 Go）要求的请求头。
 *
 * 它按目标主机判定，不按供应商身份：用户自定义的供应商只要地址落在
 * `opencode.ai` 上，就要按同样的方式发。缺 `x-opencode-session` 时网关直接
 * 返回 400。
 */

/** 宣称的客户端版本。过期版本会换来 429，用户可以用自定义请求头覆盖。 */
const OPENCODE_CLIENT_VERSION = "2.2.5";

export interface OpencodeHeadersInput {
  baseURL: string;
  /** 会话 id；网关按它路由和缓存。 */
  sessionId: string;
  /** 会话主目录。 */
  projectDir?: string;
}

/** 地址是否落在 OpenCode 的网关上。 */
export function isOpencodeURL(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname.toLowerCase().replace(/\.$/, "");
    return host === "opencode.ai" || host.endsWith(".opencode.ai");
  } catch {
    return false;
  }
}

/**
 * 合并请求头：网关默认头只是起点，用户配置的覆盖它。
 *
 * 默认头里的客户端版本会过期，用户要能改；所以这里不能反过来让默认头获胜。
 */
export function withOpencodeHeaders(
  input: OpencodeHeadersInput & {
    headers?: Readonly<Record<string, string>>;
  }
): Record<string, string> {
  return { ...opencodeHeaders(input), ...input.headers };
}

/** 该补的请求头；不是 OpenCode 的地址时返回空对象。 */
export function opencodeHeaders(
  input: OpencodeHeadersInput
): Record<string, string> {
  if (!isOpencodeURL(input.baseURL)) {
    return {};
  }

  const session = input.sessionId;
  const headers: Record<string, string> = {
    "User-Agent": `opencode/latest/${OPENCODE_CLIENT_VERSION}/cli`,
    "x-opencode-client": "cli",
    "x-opencode-session": session,
    "x-opencode-session-id": session,
    "x-session-affinity": session,
    "x-session-id": session,
    Accept: "*/*",
  };
  if (input.projectDir) {
    headers["x-opencode-project"] = input.projectDir;
  }
  return headers;
}
