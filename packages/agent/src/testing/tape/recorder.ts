import { createHash } from "node:crypto";
import { appendFile, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { eventFrameIndexes, TAPE_VERSION } from "./format.js";
import type {
  TapeFrame,
  TapeHeader,
  TapeInput,
  TapeItem,
  TapeRequest,
} from "./format.js";

export type TapeRecorderOptions = {
  /** 录制带写到哪。父目录不存在时创建。 */
  readonly out: string;
  /** 请求体只留摘要。入仓的样本要开。 */
  readonly redact?: boolean;
};

/** 脱敏后的请求体描述：摘要与长度，够回放按顺序取，不够还原内容。 */
const digestBody = (
  body: string
): Pick<TapeRequest, "bodyDigest" | "bodyBytes"> => ({
  bodyDigest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
  bodyBytes: Buffer.byteLength(body),
});

/**
 * 录制带写入器：一行一个 item，只追加。
 *
 * 供应商是唯一写入方。server 侧的输入事件经控制面推进来，也走这里，所以文件
 * 不会有两个写者交错。
 */
export class TapeRecorder {
  readonly #out: string;
  readonly #redact: boolean;
  readonly #startedAt = performance.now();
  #ready: Promise<void> | undefined;

  constructor(options: TapeRecorderOptions) {
    this.#out = options.out;
    this.#redact = options.redact ?? false;
  }

  /** 相对录制开始的毫秒。 */
  at(): number {
    return Math.round(performance.now() - this.#startedAt);
  }

  /** 写头。第一次写带时自动调用，已有文件就接着写。 */
  async header(): Promise<void> {
    await this.#ensure();
  }

  /** 记一条往返。 */
  async recordRequest(input: {
    at: number;
    method: string;
    path: string;
    stream: boolean;
    model?: string;
    body: string;
    status: number;
    headers: Readonly<Record<string, string>>;
    frames: readonly TapeFrame[];
    tailMs: number;
  }): Promise<void> {
    await this.#ensure();

    const request: TapeRequest = {
      method: input.method,
      path: input.path,
      stream: input.stream,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(this.#redact ? digestBody(input.body) : { body: input.body }),
    };

    await this.#append({
      kind: "request",
      at: input.at,
      entry: {
        request,
        response: {
          status: input.status,
          headers: { ...input.headers },
          frames: [...input.frames],
          eventFrames: eventFrameIndexes(input.frames),
          tailMs: input.tailMs,
        },
      },
    });
  }

  /** 记一条输入事件。录制时由 server 侧的钩子推过来。 */
  async recordInput(at: number, input: TapeInput): Promise<void> {
    await this.#ensure();
    await this.#append({ kind: "input", at, input });
  }

  async #append(item: TapeItem): Promise<void> {
    await appendFile(this.#out, `${JSON.stringify(item)}\n`, "utf-8");
  }

  async #ensure(): Promise<void> {
    this.#ready ??= this.#init();

    return await this.#ready;
  }

  async #init(): Promise<void> {
    await mkdir(dirname(this.#out), { recursive: true });

    if (await exists(this.#out)) {
      // 已有文件：接着写，头和版本沿用旧的。
      return;
    }

    const header: TapeHeader = {
      kind: "header",
      version: TAPE_VERSION,
      startedAt: new Date().toISOString(),
    };
    await writeFile(this.#out, `${JSON.stringify(header)}\n`, "utf-8");
  }
}

/** 文件存在与否；读不了也算不存在，让写入自己去报错。 */
const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
};

/** 删掉一条录制带。测试与「重录」用。 */
export const removeTape = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch {
    // 本来就不存在，目的已经达到。
  }
};
