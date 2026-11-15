import { readFile, writeFile } from "node:fs/promises";

import { resolveInScenarios } from "./scenario.js";

/** 一条录下来的往返：模型请求，以及供应商的原始响应。 */
export type RecordedEntry = {
  request: {
    method: string;
    path: string;
    stream?: boolean;
    model?: string;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    /** 响应体的原文；SSE 也是文本。 */
    body: string;
  };
};

/**
 * 录制：把每条往返写进一个 JSON 数组。
 *
 * 每加一条就落盘。录制进程可能在审批暂停里挂很久，被杀一次也不该丢掉前面录到的。
 */
export class Recorder {
  readonly #out: string;
  readonly #append: boolean;
  #entries: RecordedEntry[] = [];
  #loaded = false;

  constructor(out: string, append = false) {
    this.#out = out;
    this.#append = append;
  }

  async add(entry: RecordedEntry): Promise<void> {
    await this.#load();
    this.#entries.push(entry);
    await writeFile(
      this.#out,
      `${JSON.stringify(this.#entries, null, 2)}\n`,
      "utf-8"
    );
  }

  async #load(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    this.#loaded = true;

    if (!this.#append) {
      return;
    }

    try {
      this.#entries = JSON.parse(
        await readFile(this.#out, "utf-8")
      ) as RecordedEntry[];
    } catch {
      // 没有旧文件就是从头录。
      this.#entries = [];
    }
  }
}

/**
 * 回放：按顺序取录制里的下一条响应。
 *
 * 不按请求内容匹配。一次带工具的回合会发多次请求，顺序本身就是那次交互的形状；
 * 匹配规则只会带来新的复杂度，换不来更真实的行为。
 */
export class ReplayBook {
  readonly #books = new Map<
    string,
    { entries: RecordedEntry[]; cursor: number }
  >();

  /** 取下一条；`path` 相对场景目录。录制用完就返回 undefined。 */
  async take(path: string): Promise<RecordedEntry | undefined> {
    let book = this.#books.get(path);
    if (!book) {
      const entries = JSON.parse(
        await readFile(resolveInScenarios(path), "utf-8")
      ) as RecordedEntry[];
      book = { entries, cursor: 0 };
      this.#books.set(path, book);
    }

    const entry = book.entries[book.cursor];
    if (!entry) {
      return undefined;
    }

    book.cursor += 1;
    return entry;
  }
}
