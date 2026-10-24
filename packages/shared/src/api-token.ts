/**
 * 本地 API 的共享访问令牌。
 *
 * server 进程要求每个请求带 `Authorization: Bearer <token>`，Electron 主进程
 * 在转发时注入。令牌放在用户数据目录（`~/.aify-zero/api-token`，0600），
 * 这样 `dev:server` 和桌面内置 server 能用同一个令牌；CI / 远程部署则通过
 * `AIFY_API_TOKEN` 显式提供。
 *
 * 这个模块只被 Node 侧入口引用（桌面主进程、server），不要从渲染端导入：
 * 它依赖 `node:crypto` / `node:fs`。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** 显式指定令牌；优先级高于用户数据目录里的文件。 */
export const API_TOKEN_ENV = "AIFY_API_TOKEN";

const TOKEN_BYTES = 32;
const TOKEN_FILE_NAME = "api-token";
const DATA_DIRECTORY_NAME = ".aify-zero";

let cachedToken: string | undefined;

/** `~/.aify-zero/api-token`。 */
export function getApiTokenFilePath(): string {
  return path.join(homedir(), DATA_DIRECTORY_NAME, TOKEN_FILE_NAME);
}

/**
 * 读取令牌，不存在时创建。
 *
 * 先看 `AIFY_API_TOKEN`；否则读 `~/.aify-zero/api-token`。文件用 `wx` 创建，
 * 两个进程同时首次启动时只有一个能写成功，另一个回退到读。
 *
 * @returns 稳定的 bearer token。
 */
export function resolveApiToken(): string {
  if (cachedToken !== undefined) {
    return cachedToken;
  }

  const configured = process.env[API_TOKEN_ENV]?.trim();
  if (configured !== undefined && configured !== "") {
    cachedToken = configured;
    return configured;
  }

  const tokenFile = getApiTokenFilePath();
  const existing = readTokenFile(tokenFile);
  if (existing !== undefined) {
    cachedToken = existing;
    return existing;
  }

  mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });

  const generated = randomBytes(TOKEN_BYTES).toString("base64url");
  try {
    writeFileSync(tokenFile, `${generated}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    cachedToken = generated;
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    // 另一个进程刚好先写成功，或者文件存在但是空的：以磁盘上的内容为准。
    const raced = readTokenFile(tokenFile);
    if (raced !== undefined) {
      cachedToken = raced;
      return raced;
    }

    writeFileSync(tokenFile, `${generated}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    cachedToken = generated;
    return generated;
  }
}

/**
 * 恒定时间比较两个令牌。
 *
 * 先各自哈希，避免长度差异本身泄露信息，也避免 `timingSafeEqual` 对长度
 * 不一致直接抛错。
 */
export function tokensEqual(
  expected: string,
  actual: string | undefined
): boolean {
  if (actual === undefined || actual === "") {
    return false;
  }

  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();

  return timingSafeEqual(expectedDigest, actualDigest);
}

/** 从 `Authorization` 头里取出 bearer token，格式不对时返回 undefined。 */
export function extractBearerToken(
  header: string | undefined
): string | undefined {
  if (header === undefined) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();

  return token === undefined || token === "" ? undefined : token;
}

function readTokenFile(file: string): string | undefined {
  try {
    const token = readFileSync(file, "utf-8").trim();
    return token === "" ? undefined : token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
