import type {
  JobAppendOptions,
  JobChannel,
  JobChunk,
  JobOutputRead,
} from "./types";

/** 环里保留的一块；`bytes` 缓存它的 UTF-8 字节长度。 */
type RingChunk = {
  at: number;
  text: string;
  bytes: number;
  channel?: JobChannel;
  gapBefore?: true;
};

/**
 * 取 `text` 不超过 `maxBytes` 的 UTF-8 安全尾巴：字节切口会越过续字节，
 * 保证留下的文本不会从一个码点中间开始。
 * @param text - 超长的块文本。
 * @param maxBytes - 尾巴的字节预算。
 */
const utf8Tail = (
  text: string,
  maxBytes: number
): { text: string; bytes: number } => {
  const raw = Buffer.from(text, "utf-8");
  let start = raw.length - maxBytes;
  while (start < raw.length) {
    const byte = raw[start];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    start += 1;
  }
  const tail = raw.subarray(start);
  return { text: tail.toString("utf-8"), bytes: tail.length };
};

/**
 * 一个任务背后的有界输出环：块挂在绝对字节偏移上，从头淘汰但从不改写已经
 * 分配出去的偏移，任何偏移都能非消耗地读。
 *
 * 保留量以 `retainBytes` 为上限。超出时整块丢弃；只有单块就超限时才截成
 * UTF-8 安全的尾巴并打上 `gapBefore`。偏移只有 `earliest` 会前进。
 */
export class OutputRing {
  readonly #chunks: RingChunk[] = [];
  #retainedBytes = 0;
  #total = 0;
  #earliest = 0;

  /** 累计追加过的 UTF-8 字节数，也就是下一块的起始偏移。 */
  get total(): number {
    return this.#total;
  }

  /** 仍然保留着的最早字节偏移；没有保留内容时等于 `total`。 */
  get earliest(): number {
    return this.#earliest;
  }

  /** 当前保留的字节数。 */
  get retainedBytes(): number {
    return this.#retainedBytes;
  }

  /**
   * 追加一块，并把头部裁到 `cap`。
   * @param text - 按原样产出的块文本。
   * @param options - 流标签与丢失标记。
   * @param cap - 这次追加之后的保留上限，单位是 UTF-8 字节。
   * @returns 空块没有改变任何状态时返回 false。
   */
  append(
    text: string,
    options: JobAppendOptions | undefined,
    cap: number
  ): boolean {
    if (text.length === 0) {
      return false;
    }
    const bytes = Buffer.byteLength(text, "utf-8");
    this.#chunks.push({
      at: this.#total,
      text,
      bytes,
      ...(options?.channel === undefined ? {} : { channel: options.channel }),
      ...(options?.gapBefore === undefined
        ? {}
        : { gapBefore: options.gapBefore }),
    });
    this.#total += bytes;
    this.#retainedBytes += bytes;
    this.trim(cap);
    return true;
  }

  /**
   * 从头丢弃整块直到环放得下 `cap`；只剩一块且仍超限时，只保留它 UTF-8
   * 安全的尾巴，并打上 `gapBefore`。
   * @param cap - 保留上限，单位是 UTF-8 字节。
   */
  trim(cap: number): void {
    while (this.#retainedBytes > cap && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      if (dropped === undefined) {
        break;
      }
      this.#retainedBytes -= dropped.bytes;
    }
    const single = this.#chunks.length === 1 ? this.#chunks[0] : undefined;
    if (single !== undefined && single.bytes > cap) {
      const tail = utf8Tail(single.text, cap);
      single.at += single.bytes - tail.bytes;
      single.text = tail.text;
      single.bytes = tail.bytes;
      single.gapBefore = true;
      this.#retainedBytes = tail.bytes;
    }
    this.#earliest = this.#chunks[0]?.at ?? this.#total;
  }

  /**
   * 与 `[from, total)` 相交的保留块。
   * @param from - 起始的绝对字节偏移。
   * @returns 块、续读偏移，以及这些块之前是否有字节已经被淘汰。
   */
  readFrom(from: number): JobOutputRead {
    const chunks: JobChunk[] = [];
    for (const chunk of this.#chunks) {
      if (chunk.at + chunk.bytes <= from) {
        continue;
      }
      chunks.push({
        at: chunk.at,
        text: chunk.text,
        ...(chunk.channel === undefined ? {} : { channel: chunk.channel }),
        ...(chunk.gapBefore === undefined
          ? {}
          : { gapBefore: chunk.gapBefore }),
      });
    }
    return { chunks, next: this.#total, lossy: from < this.#earliest };
  }
}
