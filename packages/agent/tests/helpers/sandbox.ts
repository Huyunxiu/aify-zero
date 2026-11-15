import type { Sandbox } from "@workspace/sandbox";
import { createHostSandbox } from "@workspace/sandbox";

/**
 * 测试用的本机沙箱：`cwd` 是项目目录，默认也用同一个目录存 spill 文件。
 *
 * 沙箱不持有资源，所以每个用例直接新建一个就够了，不需要复用或清理。
 */
export const testSandbox = (
  projectDir: string,
  sessionDir: string = projectDir
): Sandbox =>
  createHostSandbox({
    id: "test-session",
    projectDirs: [projectDir],
    sessionDir,
  });
