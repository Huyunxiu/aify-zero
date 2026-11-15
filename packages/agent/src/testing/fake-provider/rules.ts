import type { Rule } from "./scenario.js";

/** 一次请求里，规则能看到的全部信息。 */
export type FakeRequest = {
  /** 供应商这一侧的请求是不是流式的。 */
  readonly stream: boolean;
  readonly model?: string;
};

/**
 * 一份场景的规则书。
 *
 * 规则按文件顺序消费；条件对不上的规则不消费，留着等下一次请求。这条「留着」
 * 是整个类存在的理由：会话标题的请求不该消耗掉给对话准备的第一次失败——第一
 * 版手动验证正是在这里踩的坑，一次 429 被标题吃掉，看起来像重试坏了。
 */
export class RuleBook {
  readonly #rules: readonly Rule[];
  readonly #used = new Set<number>();

  constructor(rules: readonly Rule[]) {
    this.#rules = rules;
  }

  /** 取下一条适用于这次请求的规则；没有了就返回 undefined。 */
  take(request: FakeRequest): Rule | undefined {
    for (const [index, rule] of this.#rules.entries()) {
      if (this.#used.has(index) || !matches(rule, request)) {
        continue;
      }

      this.#used.add(index);
      return rule;
    }

    return undefined;
  }

  get remaining(): number {
    return this.#rules.length - this.#used.size;
  }
}

/** 这条规则是不是为这次请求准备的。没写 `when` 就对所有请求都适用。 */
export function matches(rule: Rule, request: FakeRequest): boolean {
  const { when } = rule;
  if (!when) {
    return true;
  }

  if (when.stream !== undefined && when.stream !== request.stream) {
    return false;
  }

  if (when.model !== undefined && when.model !== request.model) {
    return false;
  }

  return true;
}
