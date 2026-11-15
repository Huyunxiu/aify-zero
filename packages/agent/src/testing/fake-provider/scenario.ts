import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/** 场景目录：包根的 `scenarios/`，与 `tests/` 并排。 */
const SCENARIOS_DIR = new URL("../../../scenarios/", import.meta.url);

const slowSchema = z.object({
  /** 第一个块之前等多久。 */
  firstChunkMs: z.number().nonnegative().optional(),
  /** 块与块之间等多久。 */
  chunkMs: z.number().nonnegative().optional(),
});

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

/**
 * 流内错误只认这几个字段。
 *
 * 它存在的理由是控制分类（`statusCode`、`isRetryable`、消息文本），不是塞一段
 * 任意 JSON——那会变成第二个 `raw` 逃生口。
 */
const streamErrorSchema = z.object({
  message: z.string(),
  type: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
  statusCode: z.number().optional(),
  isRetryable: z.boolean().optional(),
});

// 同名字段在多个变体里共用：schema 是不可变的，引用同一个实例没有副作用。
const when = whenSchema.optional();
const slow = slowSchema.optional();

/**
 * 每条规则正好有一个结果，`kind` 由解析补上。
 *
 * 写出来的 JSON 保持扁平（`{ "fail": 429 }`），读出来的值却是判别联合：消费端
 * `switch (rule.kind)`，不用在六个可选键上连写 `if`。放错位置的修饰也是解析错误，
 * 不会被悄悄丢掉。
 */
const ruleVariants = [
  z
    .object({ when, answer: z.string(), slow })
    .strict()
    .transform((rule) => ({ kind: "answer" as const, ...rule })),
  z
    .object({
      when,
      fail: z.number().int().min(400).max(599),
      retryAfter: z.number().nonnegative().optional(),
      retryAfterMs: z.number().nonnegative().optional(),
    })
    .strict()
    .transform((rule) => ({ kind: "fail" as const, ...rule })),
  z
    .object({
      when,
      failMidStream: z
        .object({
          text: z.string().optional(),
          error: streamErrorSchema.optional(),
        })
        .strict(),
      slow,
    })
    .strict()
    .transform((rule) => ({ kind: "failMidStream" as const, ...rule })),
  z
    .object({ when, replay: z.string() })
    .strict()
    .transform((rule) => ({ kind: "replay" as const, ...rule })),
  z
    .object({ when, reset: z.literal(true) })
    .strict()
    .transform((rule) => ({ kind: "reset" as const, ...rule })),
  z
    .object({ when, corrupt: z.literal(true) })
    .strict()
    .transform((rule) => ({ kind: "corrupt" as const, ...rule })),
] as const;

export const ruleSchema = z.union(ruleVariants);

export const scenarioSchema = z.object({
  name: z.string(),
  /** `GET /models` 对外声明的模型名；缺省是场景名。 */
  models: z.array(z.string()).optional(),
  rules: z.array(ruleSchema).min(1),
});

export type Rule = z.output<typeof ruleSchema>;
/** 场景的写出来的样子：扁平、没有 `kind`。 */
export type ScenarioInput = z.input<typeof scenarioSchema>;
/** 解析之后的样子：规则是判别联合。 */
export type Scenario = z.output<typeof scenarioSchema>;

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
