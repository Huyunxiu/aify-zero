import { createDeleteFileTool } from "../../tools/delete-file";
import { createEditFileTool } from "../../tools/edit-file";
import { createGlobTool } from "../../tools/glob";
import { createGrepTool } from "../../tools/grep";
import { createReadFileTool } from "../../tools/read-file";
import { createWriteFileTool } from "../../tools/write-file";
import type { ExtensionAPI, ExtensionOptions } from "../types";
import { Extension } from "../types";

const DEFAULT_OPTIONS: ExtensionOptions = { id: "file-tools" };

/**
 * 文件工具扩展：读写、编辑、删除、grep、glob。
 *
 * 这些工具只依赖 {@link ToolEnvironment} 里的路径，不依赖会话历史或存储。
 */
export class FileToolsExtension extends Extension {
  constructor(options: ExtensionOptions = DEFAULT_OPTIONS) {
    super(options);
  }

  init(api: ExtensionAPI): void {
    const { environment } = api;

    api.tool("read-file", createReadFileTool({ agentContext: environment }));
    api.tool("write-file", createWriteFileTool({ agentContext: environment }));
    api.tool(
      "delete-file",
      createDeleteFileTool({ agentContext: environment })
    );
    api.tool("edit-file", createEditFileTool({ agentContext: environment }));
    api.tool("grep", createGrepTool({ agentContext: environment }));
    api.tool("glob", createGlobTool({ agentContext: environment }));

    // 写和删会改用户文件，调用前交给用户确认。策略跟着工具走，宿主不用
    // 再维护一份名单。
    api.approvalRequired("write-file");
    api.approvalRequired("delete-file");
  }
}
