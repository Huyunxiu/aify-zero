import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/** 场景目录：包根的 `scenarios/`，与 `tests/` 并排。 */
const SCENARIOS_DIR = new URL("../../../scenarios/", import.meta.url);

/** 规则的六个结果。每条规则正好有一个。 */
export const OUTCOMES = [
  "answer",
  "fail",
  "failMidStream",
  "replay",
  "reset",
  "corrupt",
] as const;

const whenSchema = z.object({
  /**
   * 请求是不是流式的。
   *
   * 会话的标题生成也走同一个供应商，但它是非流式的；不分开的话，它会吃掉给对
   * 话准备的第一次失败。
   */
  stream: z.boolean().optional(),
  model: z.string().optional(),
});

const slowSchema = z.object({
  /** 第一个块之前等多久。 */
  firstChunkMs: z.number().nonnegative().optional(),
  /** 块与块之间等多久。 */
  chunkMs: z.number().nonnegative().optional(),
});

export const ruleSchema = z
  .object({
    when: whenSchema.optional(),
    /** `Retry-After`，单位秒。 */
    retryAfter: z.number().nonnegative().optional(),
    /** `retry-after-ms`，单位毫秒；比 `retryAfter` 优先。 */
    retryAfterMs: z.number().nonnegative().optional(),
    slow: slowSchema.optional(),
    answer: z.string().optional(),
    fail: z.number().int().min(400).max(599).optional(),
    failMidStream: z
      .object({
        /** 报错之前先发出去的文字。 */
        text: z.string().optional(),
        /** 流内错误对象；不写就是 `{ message: "overloaded" }`。 */
        error: z.unknown().optional(),
      })
      .optional(),
    /** 录制文件，按顺序取下一条响应。 */
    replay: z.string().optional(),
    reset: z.boolean().optional(),
    corrupt: z.boolean().optional(),
  })
  .refine(
    (rule) =>
      OUTCOMES.filter((outcome) => rule[outcome] !== undefined).length === 1,
    {
      message: `每条规则必须正好有一个结果：${OUTCOMES.join(" / ")}`,
    }
  );

export const scenarioSchema = z.object({
  name: z.string(),
  /** `GET /models` 对外声明的模型名；缺省是场景名。 */
  models: z.array(z.string()).optional(),
  rules: z.array(ruleSchema).min(1),
});

export type Rule = z.infer<typeof ruleSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
export type RuleWhen = z.infer<typeof whenSchema>;

/**
 * 按名字或路径取一个场景。
 *
 * 名字走包根的 `scenarios/<name>.json`；带 `/` 或以 `.json` 结尾的按路径处理，
 * 相对路径相对当前目录。
 */
export async function loadScenario(nameOrPath: string): Promise<Scenario> {
  const path = resolveScenarioPath(nameOrPath);
  return scenarioSchema.parse(JSON.parse(await readFile(path, "utf-8")));
}

/** 场景目录里的一个文件；`recorded/x.json` 这类相对路径从这里算。 */
export function resolveInScenarios(relative: string): string {
  return isAbsolute(relative)
    ? relative
    : fileURLToPath(new URL(relative, SCENARIOS_DIR));
}

export function resolveScenarioPath(nameOrPath: string): string {
  if (isAbsolute(nameOrPath)) {
    return nameOrPath;
  }

  const looksLikePath =
    nameOrPath.includes("/") || nameOrPath.endsWith(".json");
  if (looksLikePath) {
    return resolve(process.cwd(), nameOrPath);
  }

  return fileURLToPath(new URL(`${nameOrPath}.json`, SCENARIOS_DIR));
}
