import {
  createHostSandboxAdapter,
  createIsolatedSandboxAdapter,
} from "@workspace/sandbox";
import type { Sandbox, SandboxAdapter } from "@workspace/sandbox";

/**
 * 进程级的会话沙箱注册表。
 *
 * `buildSessionAgent` 每回合都跑一次，沙箱不能按回合建：远端容器和本机进程
 * 空间都要跨回合复用。所以沙箱按会话 id 缓存在这里，装配时只取一次。
 *
 * 用哪个适配器由 `AIFY_SANDBOX_BACKEND` 决定，默认 `host`（保持引入沙箱之前的
 * 行为）。没有设置界面：等第二个适配器被真正使用过、知道该按全局还是按项目
 * 配置之后再进数据库。
 */
const BACKEND_ENV = "AIFY_SANDBOX_BACKEND";

const DEFAULT_BACKEND = "host";

/** 当前选中的后端与它的适配器；env 变了就换一个，便于同一进程内切换与测试。 */
let selected: { backend: string; adapter: SandboxAdapter } | undefined;

const sandboxes = new Map<string, Promise<Sandbox>>();

export interface AcquireSessionSandboxInput {
  sessionId: string;
  projectDirs: readonly string[];
  sessionDir: string;
}

/** 按名字建适配器；名字不认识就抛，不退回默认值。 */
function createAdapter(backend: string): SandboxAdapter {
  switch (backend) {
    case "host": {
      return createHostSandboxAdapter();
    }
    case "isolated": {
      return createIsolatedSandboxAdapter();
    }
    default: {
      throw new Error(
        `Unknown ${BACKEND_ENV}: "${backend}". Use "host" or "isolated".`
      );
    }
  }
}

function getAdapter(): SandboxAdapter {
  const backend =
    (process.env[BACKEND_ENV] ?? DEFAULT_BACKEND).trim() || DEFAULT_BACKEND;
  if (selected?.backend === backend) {
    return selected.adapter;
  }

  const adapter = createAdapter(backend);
  selected = { backend, adapter };
  return adapter;
}

/**
 * 取这个会话的沙箱，第一次调用时创建。
 *
 * 创建中的 promise 也进表：并发的两个回合只建一个实例。失败就删掉条目，
 * 下一次调用重新试一遍——缓存一个失败的 promise 会让会话永久坏掉。
 */
export async function acquireSessionSandbox(
  input: AcquireSessionSandboxInput
): Promise<Sandbox> {
  const existing = sandboxes.get(input.sessionId);
  if (existing !== undefined) {
    return await existing;
  }

  const pending = getAdapter()
    .acquire({
      id: input.sessionId,
      projectDirs: input.projectDirs,
      sessionDir: input.sessionDir,
    })
    .then((handle) => handle.sandbox);

  sandboxes.set(input.sessionId, pending);
  pending.catch(() => {
    sandboxes.delete(input.sessionId);
  });

  return await pending;
}

/** 会话结束或删除时丢掉对应的沙箱。 */
export function releaseSessionSandbox(sessionId: string): void {
  sandboxes.delete(sessionId);
}
