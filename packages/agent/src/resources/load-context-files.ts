import { logger } from "@workspace/shared/logger";

import { loadProjectContextFiles } from "../context-files";
import type { ContextFile } from "../context-files";
import type { ContextSource, ResourceLoadContext } from "./types";

/**
 * 依次加载所有上下文源，按 `path` 合并。
 *
 * 后加载的源覆盖同 path 的内容，但保留首次出现的位置：数据库可以替换文件
 * 系统里的说明，同时不打乱「全局在前、项目在后」的顺序。单个源失败只记
 * 日志，不拖垮其他源。
 */
export async function loadContextFiles(
  sources: readonly ContextSource[],
  context: ResourceLoadContext
): Promise<ContextFile[]> {
  const results = await Promise.allSettled(
    sources.map((source) => source.load(context))
  );

  const merged = new Map<string, ContextFile>();
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      logger.warn(
        `[resources] context source ${index} failed to load`,
        result.reason
      );
      continue;
    }
    for (const file of result.value) {
      merged.set(file.path, file);
    }
  }

  return [...merged.values()];
}

/** 从文件系统加载上下文文件，包住现有的 `loadProjectContextFiles`。 */
export class FileSystemContextSource implements ContextSource {
  readonly #globalDirs?: string[];

  constructor(options: { globalDirs?: string[] } = {}) {
    this.#globalDirs = options.globalDirs;
  }

  load(context: ResourceLoadContext): Promise<ContextFile[]> {
    return Promise.resolve(
      loadProjectContextFiles({
        cwd: context.workdir,
        globalDirs: this.#globalDirs,
      })
    );
  }
}
