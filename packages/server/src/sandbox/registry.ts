import type { BotSandboxConfig } from "@workspace/agent-client";
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

const ADAPTER_ENV = "AIFY_SANDBOX_ADAPTER";
const IMAGE_ENV = "AIFY_SANDBOX_IMAGE";
const DEFAULT_ADAPTER = "host";

interface CachedSandbox {
  readonly configKey: string;
  readonly handle: Promise<SandboxHandle>;
}

/** Cache of adapter instances keyed by adapter name (and container image). */
const adapters = new Map<string, SandboxAdapter>();

/**
 * Session id -> config-keyed cached sandbox handle.
 *
 * A Bot's sandbox config applies live on the next Run by invalidating only that
 * session's cached handle when its computed `configKey` changes.
 */
const sandboxes = new Map<string, CachedSandbox>();

export interface AcquireSessionSandboxInput {
  sessionId: string;
  projectDirs: readonly string[];
  sessionDir: string;
  sandbox?: BotSandboxConfig;
  readOnlyDirs?: readonly string[];
  env?: Readonly<Record<string, string>>;
  homeDir?: string;
}

function resolveAdapterName(sandbox?: BotSandboxConfig): {
  adapterName: string;
  fromEnv: boolean;
} {
  if (sandbox && sandbox.adapter !== "inherit") {
    return { adapterName: sandbox.adapter, fromEnv: false };
  }
  const envName =
    (process.env[ADAPTER_ENV] ?? DEFAULT_ADAPTER).trim() || DEFAULT_ADAPTER;
  return { adapterName: envName, fromEnv: true };
}

function resolveContainerImage(sandbox?: BotSandboxConfig): string | undefined {
  const botImage = sandbox?.image?.trim();
  if (botImage && botImage.length > 0) {
    return botImage;
  }
  const envImage = process.env[IMAGE_ENV]?.trim();
  return envImage && envImage.length > 0 ? envImage : undefined;
}

function getAdapter(
  name: string,
  image: string | undefined,
  fromEnv: boolean
): SandboxAdapter {
  const key =
    name === APPLE_CONTAINER_ADAPTER ? `${name}:${image ?? ""}` : name;
  const cached = adapters.get(key);
  if (cached) {
    return cached;
  }

  let adapter: SandboxAdapter;
  switch (name) {
    case "host": {
      adapter = createHostSandboxAdapter();
      break;
    }
    case "isolated": {
      adapter = createIsolatedSandboxAdapter();
      break;
    }
    case APPLE_CONTAINER_ADAPTER: {
      adapter = createAppleContainerSandboxAdapter(
        image === undefined ? {} : { image }
      );
      break;
    }
    default: {
      if (fromEnv) {
        throw new Error(
          `Unknown ${ADAPTER_ENV}: "${name}". Use "host", "isolated" or "${APPLE_CONTAINER_ADAPTER}".`
        );
      }
      throw new Error(
        `Unknown sandbox adapter: "${name}". Use "host", "isolated" or "${APPLE_CONTAINER_ADAPTER}".`
      );
    }
  }

  adapters.set(key, adapter);
  return adapter;
}

function buildConfigKey(input: {
  adapterName: string;
  image?: string;
  projectDirs: readonly string[];
  sessionDir: string;
  readOnlyDirs?: readonly string[];
  env?: Readonly<Record<string, string>>;
  homeDir?: string;
}): string {
  const sortedEnv = input.env
    ? Object.entries(input.env).toSorted(([a], [b]) => a.localeCompare(b))
    : [];
  return JSON.stringify({
    adapterName: input.adapterName,
    image:
      input.adapterName === APPLE_CONTAINER_ADAPTER ? input.image : undefined,
    projectDirs: input.projectDirs,
    sessionDir: input.sessionDir,
    readOnlyDirs: input.readOnlyDirs ?? [],
    env: sortedEnv,
    homeDir: input.homeDir,
  });
}

async function disposeHandle(entry: Promise<SandboxHandle>): Promise<void> {
  try {
    const handle = await entry;
    await handle.dispose?.();
  } catch {
    // Failed acquisitions have no live handle to dispose.
  }
}

/** Release a session's cached sandbox handle, if present. */
export async function releaseSessionSandbox(sessionId: string): Promise<void> {
  const entry = sandboxes.get(sessionId);
  if (entry === undefined) {
    return;
  }

  sandboxes.delete(sessionId);
  await disposeHandle(entry.handle);
}

/** Clear all cached sandboxes and adapter instances (primarily for tests or shutdown). */
export async function clearSessionSandboxes(): Promise<void> {
  const entries = [...sandboxes.values()].map((entry) => entry.handle);
  sandboxes.clear();
  adapters.clear();
  await Promise.all(entries.map(disposeHandle));
}

/**
 * Acquire the session sandbox, rebuilding only that session's handle if its
 * resolved adapter, image, directories, environment, or HOME changed.
 */
export async function acquireSessionSandbox(
  input: AcquireSessionSandboxInput
): Promise<Sandbox> {
  const { adapterName, fromEnv } = resolveAdapterName(input.sandbox);
  const image =
    adapterName === APPLE_CONTAINER_ADAPTER
      ? resolveContainerImage(input.sandbox)
      : undefined;

  const configKey = buildConfigKey({
    adapterName,
    image,
    projectDirs: input.projectDirs,
    sessionDir: input.sessionDir,
    readOnlyDirs: input.readOnlyDirs,
    env: input.env,
    homeDir: input.homeDir,
  });

  const existing = sandboxes.get(input.sessionId);
  if (existing !== undefined) {
    if (existing.configKey === configKey) {
      const handle = await existing.handle;
      return handle.sandbox;
    }

    sandboxes.delete(input.sessionId);
    await disposeHandle(existing.handle);
  }

  const adapter = getAdapter(adapterName, image, fromEnv);
  const pending = adapter.acquire({
    id: input.sessionId,
    projectDirs: input.projectDirs,
    sessionDir: input.sessionDir,
    ...(input.readOnlyDirs === undefined
      ? {}
      : { readOnlyDirs: input.readOnlyDirs }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.homeDir === undefined ? {} : { homeDir: input.homeDir }),
  });

  const cached: CachedSandbox = { configKey, handle: pending };
  sandboxes.set(input.sessionId, cached);
  pending.catch(() => {
    if (sandboxes.get(input.sessionId) === cached) {
      sandboxes.delete(input.sessionId);
    }
  });

  const handle = await pending;
  return handle.sandbox;
}
