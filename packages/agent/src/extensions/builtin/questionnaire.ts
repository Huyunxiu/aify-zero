import { createQuestionnaireTool } from "../../tools/questionnaire";
import { Capabilities } from "../capabilities";
import type { ExtensionAPI, ExtensionOptions } from "../types";
import { Extension } from "../types";

const DEFAULT_OPTIONS: ExtensionOptions = { id: "questionnaire" };

/**
 * 问卷扩展：让模型向用户提问，答案从下一次审批流回来。
 *
 * 工具通过 transcript capability 找到自己的调用和答案；审批声明跟着工具
 * 一起走，不需要宿主再列一遍。
 */
export class QuestionnaireExtension extends Extension {
  constructor(options: ExtensionOptions = DEFAULT_OPTIONS) {
    super(options);
  }

  init(api: ExtensionAPI): void {
    api.tool(
      "questionnaire",
      createQuestionnaireTool({
        transcript: api.use(Capabilities.transcript),
      })
    );
    api.approvalRequired("questionnaire");
  }
}
