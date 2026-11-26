/**
 * 一条端到端用例的现场：临时目录、假供应商、真实的 API 子进程、Vite dev server。
 *
 * 现场按次创建，跑完就拆。失败或显式要求保留时，留在 `.e2e/runs/<时间戳>/` 里。
 */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startFakeProvider } from "@workspace/agent/testing";
import type { FakeProvider, Scenario } from "@workspace/agent/testing";

/** 仓库根：本文件在 `e2e/` 下。 */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** `vp` 统一管运行：脚本从它走，不直接拼 `node_modules/.bin`。 */
const VP_BIN = join(REPO_ROOT, "node_modules", ".bin", "vp");

/** 供应商设置里的那条记录用的模型 id；场景对外也声明这个名字。 */
const FAKE_MODEL_ID = "fake-fast";

/** 端到端用例里的项目名；断言的文字就是它。 */
export const PROJECT_NAME = "E2E project";

/** 仓库里那个待改文件的初始内容。 */
const NOTES = "# Notes\n\nfirst line\nsecond line\n";

export type Stack = {
  readonly fake: FakeProvider;
  /** server 启动时打印的那条登录链接，带 `?token=`。 */
  readonly loginUrl: string;
  /** API 的基地址；用例要读 `/timer/state` 这类只读状态时用。 */
  readonly apiUrl: string;
  /** 请求 API 用的机器凭据。 */
  readonly token: string;
  readonly projectDir: string;
  /** 拆现场。`keep` 为真时留下目录当证据。 */
  stop(options?: { readonly keep?: boolean }): Promise<void>;
};

/** 让系统挑一个空闲端口；拿不到就抛。 */
const freePort = async (): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

/**
 * 轮询一个可能还没准备好的值；`read` 可以是异步的。
 *
 * 用例也用同一个：要等的东西大多在另一个进程里，只有「再来一次」这一种问法。
 */
export const waitFor = async <T>(
  read: () => Promise<T | undefined> | T | undefined,
  what: string,
  timeoutMs = 60_000
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** 一个子进程和它的 stdout，写进日志文件的同时也留在内存里等启动信号。 */
type Child = {
  readonly output: () => string;
  readonly stop: () => Promise<void>;
};

const startChild = (input: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logPath: string;
}): Child => {
  const log: string[] = [];
  const child: ChildProcess = spawn(VP_BIN, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    // 单独一个进程组：拆的时候把 vite 拉起的子进程一起收掉。
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const record = (chunk: Buffer): void => {
    const text = chunk.toString("utf-8");
    log.push(text);
    writeFileSync(input.logPath, text, { flag: "a" });
  };

  child.stdout?.on("data", record);
  child.stderr?.on("data", record);

  return {
    output: () => log.join(""),
    stop: async () => {
      const { pid } = child;
      if (pid === undefined || child.exitCode !== null) {
        return;
      }

      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          resolve();
        };

        const timer = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
          finish();
        }, 5000);

        child.once("exit", () => {
          clearTimeout(timer);
          finish();
        });
      });
    },
  };
};

/** 起一个临时 Git 仓库：一次提交、一个 `notes.md`，改动视图才有基线可比。 */
const createProjectRepository = (projectDir: string): void => {
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "notes.md"), NOTES);

  const git = (args: readonly string[]): void => {
    execFileSync(
      "git",
      ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args],
      { cwd: projectDir, stdio: "ignore" }
    );
  };

  git(["init", "--quiet"]);
  git(["add", "notes.md"]);
  git(["commit", "--quiet", "-m", "notes"]);
};

/** 把假供应商写进设置；走真实鉴权和输入校验。 */
const seedProvider = async (input: {
  readonly apiUrl: string;
  readonly baseURL: string;
  readonly token: string;
}): Promise<void> => {
  const response = await fetch(`${input.apiUrl}/api/rpc/setting/update`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    // oRPC 的 RPC 传输把入参放在 `json` 字段里；响应也包在 `json` 里。
    body: JSON.stringify({
      json: {
        providers: [
          {
            id: "fake",
            name: "Fake",
            protocol: "openai-chat",
            baseURL: input.baseURL,
            apiKey: "sk-test",
            active: true,
            // The fake provider answers the same way for every media kind, so the model
            // declares that it reads images. Without it, a case that reads an image would
            // have the image replaced by a sentence in request assembly: the right
            // failure, but it would never reach the protocol.
            models: [
              {
                id: FAKE_MODEL_ID,
                name: FAKE_MODEL_ID,
                active: true,
                modalities: { input: ["text", "image"], output: ["text"] },
              },
            ],
          },
        ],
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `failed to seed the provider: ${response.status} ${await response.text()}`
    );
  }
};

/**
 * 起一整套现场，等它真的能服务请求。
 *
 * `scenario` 换假供应商的剧本：主流程要工具，批处理用例要一段够长的流，
 * 好让后两条消息在第一次运行还没结束时排进队列。日程用例要在运行时算出一个
 * 「下一个整分」，所以这里也收场次对象本身。
 */
export async function startStack(
  input: { readonly scenario?: string | Scenario } = {}
): Promise<Stack> {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const runDir = join(REPO_ROOT, ".e2e", "runs", stamp);
  const projectDir = join(runDir, "project");
  const logsDir = join(runDir, "logs");

  mkdirSync(logsDir, { recursive: true });
  mkdirSync(join(runDir, "home"), { recursive: true });
  mkdirSync(join(runDir, "db"), { recursive: true });
  createProjectRepository(projectDir);

  const [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
  const token = "e2e-token";
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(runDir, "home"),
    AIFY_API_HOST: "127.0.0.1",
    AIFY_API_PORT: String(apiPort),
    AIFY_WEB_PORT: String(webPort),
    AIFY_API_TOKEN: token,
    AIFY_SANDBOX_ADAPTER: "host",
    DATABASE_URL: `file:${join(runDir, "db", "app.db")}`,
    // 空串按「没有设置」处理：开发机上导出过的 API 源不能盖掉这次挑的端口，
    // 否则 Vite 会把请求代理到另一个 API，而断言还在看测试进程里的假供应商。
    AIFY_API_ORIGIN: "",
  };
  const apiEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    // 显式给出页面的源：server 就不必在启动时探测 Vite 在不在，登录链接也不会
    // 因为「探测超时」而指回 API 自己。
    AIFY_WEB_ORIGIN: webUrl,
    // 定时器用例要在一分钟内看到一次到点：扫描间隔降到 1 秒，而定时器本身的
    // 60 秒下限不动——那是契约的一部分，用例就该真的等满一分钟。
    AIFY_TIMER_SCAN_MS: "1000",
  };

  const fake = await startFakeProvider({
    scenario: input.scenario ?? "edit-then-answer",
  });
  // 先起页面，等它真能服务请求，再起 API：链接里的源是确定的，页面也早就绪。
  const web = startChild({
    args: ["run", "web#dev"],
    cwd: REPO_ROOT,
    env: baseEnv,
    logPath: join(logsDir, "web.log"),
  });

  let api: Child | undefined;

  const stop = async (stopOptions: { readonly keep?: boolean } = {}) => {
    await Promise.all([api?.stop(), web.stop()]);
    await fake.close();
    if (!stopOptions.keep) {
      rmSync(runDir, { recursive: true, force: true });
    }
  };

  try {
    await waitFor(async () => {
      let response: Response | undefined;
      try {
        response = await fetch(webUrl);
      } catch {
        response = undefined;
      }
      return response?.ok === true ? true : undefined;
    }, "the web dev server");

    const apiChild = startChild({
      args: ["exec", "tsx", "apps/server/src/index.ts"],
      cwd: REPO_ROOT,
      env: apiEnv,
      logPath: join(logsDir, "api.log"),
    });
    api = apiChild;

    // server 打印的登录链接是唯一能直接拿去开页面的入口。
    const loginUrl = await waitFor(
      () => /\[auth\] sign in: (\S+)/u.exec(apiChild.output())?.[1],
      "the sign-in link printed by the API"
    );

    await seedProvider({ apiUrl, baseURL: fake.baseURL, token });

    return { fake, loginUrl, apiUrl, token, projectDir, stop };
  } catch (error) {
    await stop({ keep: true });
    throw new Error(`the stack did not come up; logs are in ${runDir}`, {
      cause: error,
    });
  }
}
