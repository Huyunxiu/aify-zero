import {
  APPLE_CONTAINER_ADAPTER,
  createAppleContainerSandboxAdapter,
  createHostSandboxAdapter,
  createIsolatedSandboxAdapter,
} from "@workspace/sandbox";
import type {
  Sandbox,
  SandboxAdapter,
  SandboxHandle,
} from "@workspace/sandbox";

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

/** Apple 容器适配器的镜像；只有它读这个变量。 */
const IMAGE_ENV = "AIFY_SANDBOX_IMAGE";

const DEFAULT_ADAPTER = "host";

/** 当前选中的沙箱适配器；env 变了就换一个，便于同一进程内切换与测试。 */
let selected: { name: string; adapter: SandboxAdapter } | undefined;

/**
 * 会话 id → 沙箱句柄。
 *
 * 存句柄而不是沙箱：容器这类适配器要留下东西，换适配器时得能释放。条目跟着
 * 跑过回合的会话数增长，只在两种情况消失：换适配器时整表释放，会话删除时由
 * `releaseSessionSandbox` 单独释放。
 */
const sandboxes = new Map<string, Promise<SandboxHandle>>();

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
    case APPLE_CONTAINER_ADAPTER: {
      const image = process.env[IMAGE_ENV]?.trim();
      return createAppleContainerSandboxAdapter(
        image === undefined || image.length === 0 ? {} : { image }
      );
    }
    default: {
      throw new Error(
        `Unknown ${ADAPTER_ENV}: "${name}". Use "host", "isolated" or "${APPLE_CONTAINER_ADAPTER}".`
      );
    }
  }
}

/** 释放一个句柄；建失败的沙箱没有可释放的东西。 */
async function disposeHandle(entry: Promise<SandboxHandle>): Promise<void> {
  try {
    const handle = await entry;
    await handle.dispose?.();
  } catch {
    // 建失败的沙箱没有可释放的东西。
  }
}

/**
 * 释放所有缓存的句柄。
 *
 * 同步清表再逐个释放：清表必须立刻生效，否则下一次装配还会拿到旧适配器的实例。
 */
async function disposeAll(): Promise<void> {
  const entries = [...sandboxes.values()];
  sandboxes.clear();
  await Promise.all(entries.map(disposeHandle));
}

/**
 * 释放一个会话缓存着的沙箱句柄。
 *
 * 会话删掉之后不会再有人装配它，缓存留着就是一个永不释放的容器。同步清表、再
 * 异步释放：真有人用同一个 id 再来，下一次装配重新建一个。
 */
export async function releaseSessionSandbox(sessionId: string): Promise<void> {
  const entry = sandboxes.get(sessionId);
  if (entry === undefined) {
    return;
  }

  sandboxes.delete(sessionId);
  await disposeHandle(entry);
}

function getAdapter(): SandboxAdapter {
  const name =
    (process.env[ADAPTER_ENV] ?? DEFAULT_ADAPTER).trim() || DEFAULT_ADAPTER;
  if (selected?.name === name) {
    return selected.adapter;
  }

  const adapter = createAdapter(name);
  selected = { name, adapter };
  // 换了适配器，旧适配器建出来的沙箱不能再给会话用：清掉并释放，让下一次装配
  // 按新适配器重取。不清等于同一进程里两个适配器的实例混在一起，容器还会漏。
  void disposeAll();
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
    const handle = await existing;
    return handle.sandbox;
  }

  const pending = adapter.acquire({
    id: input.sessionId,
    projectDirs: input.projectDirs,
    sessionDir: input.sessionDir,
  });

  sandboxes.set(input.sessionId, pending);
  pending.catch(() => {
    sandboxes.delete(input.sessionId);
  });

  const handle = await pending;
  return handle.sandbox;
}
