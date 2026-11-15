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
 * 用哪个沙箱适配器由 `AIFY_SANDBOX_ADAPTER` 决定，默认 `host`（保持引入沙箱之前
 * 的行为）。没有设置界面：等第二个适配器被真正使用过、知道该按全局还是按项目
 * 配置之后再进数据库。
 */
const ADAPTER_ENV = "AIFY_SANDBOX_ADAPTER";

const DEFAULT_ADAPTER = "host";

/** 当前选中的沙箱适配器；env 变了就换一个，便于同一进程内切换与测试。 */
let selected: { name: string; adapter: SandboxAdapter } | undefined;

/**
 * 会话 id → 沙箱。
 *
 * 没有淘汰：条目会在进程存活期间跟着跑过回合的会话数增长，但一个条目就是几个
 * 字段（本机适配器不持有资源）。等会话删除的流程出现时再接淘汰，现在提前加一个
 * 没人调用的清理函数只会变成死代码。
 */
const sandboxes = new Map<string, Promise<Sandbox>>();

export interface AcquireSessionSandboxInput {
  sessionId: string;
  projectDirs: readonly string[];
  sessionDir: string;
}

/** 按名字建适配器；名字不认识就抛，不退回默认值。 */
function createAdapter(name: string): SandboxAdapter {
  switch (name) {
    case "host": {
      return createHostSandboxAdapter();
    }
    case "isolated": {
      return createIsolatedSandboxAdapter();
    }
    default: {
      throw new Error(
        `Unknown ${ADAPTER_ENV}: "${name}". Use "host" or "isolated".`
      );
    }
  }
}

function getAdapter(): SandboxAdapter {
  const name =
    (process.env[ADAPTER_ENV] ?? DEFAULT_ADAPTER).trim() || DEFAULT_ADAPTER;
  if (selected?.name === name) {
    return selected.adapter;
  }

  const adapter = createAdapter(name);
  selected = { name, adapter };
  // 换了适配器，旧适配器建出来的沙箱不能再给会话用：清掉，让下一次装配按新
  // 适配器重取。不清等于同一进程里两个适配器的实例混在一起。
  sandboxes.clear();
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
  // 先选适配器：它在 env 变化时会清空缓存，之后查到的才是同一个适配器的实例。
  const adapter = getAdapter();
  const existing = sandboxes.get(input.sessionId);
  if (existing !== undefined) {
    return await existing;
  }

  const pending = adapter
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
