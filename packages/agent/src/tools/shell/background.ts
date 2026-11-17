import { createWriteStream, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { dirname } from "node:path";

import { OutputRing } from "../../jobs/ring";
import type { JobOutputSource } from "../../jobs/types";
import type { ShellChannel } from "./output";

/** 单条流在后台任务里保留的输出上限，和注册表运行期的环同一个量级。 */
const RETAIN_BYTES = 256 * 1024;

/** 落盘文件的上限，避免一条跑飞的命令写满磁盘。 */
const MAX_SPILL_BYTES = 64 * 1024 * 1024;

/**
 * 后台命令的输出缓冲：每条流一个输出环，按 UTF-8 字节记住最近的输出。
 *
 * 它不是模型的读取端——模型的读取由注册表的环负责；这里只是注册表拉取源
 * 背后的生产者侧缓冲，两者都按绝对偏移提供非消耗读取。开启落盘后，同一份
 * 文本还会按到达顺序写入一个文件，供模型在输出被淘汰后重读。
 */
export type ShellStreamBuffer = {
  /** 喂入一块原始字节；解码跨块拼接，不会切坏多字节字符。 */
  push(channel: ShellChannel, chunk: Buffer): void;
  /** 结束解码，把解码器里剩下的尾巴写进环并关闭落盘文件。 */
  close(): void;
  /** 注册表要拉取的两个源，stdout 在前。 */
  sources: readonly JobOutputSource[];
  /**
   * 开始把后续输出写进指定文件。在任务 id 签发之后调用；目录不存在时创建。
   * @param path - 落盘文件的宿主路径。
   */
  spillTo(path: string): void;
};

/**
 * 建一个后台命令的输出缓冲。
 * @returns 生产者侧的写入面、落盘入口和两个拉取源。
 */
export const createShellStreamBuffer = (): ShellStreamBuffer => {
  const channels: readonly ShellChannel[] = ["stdout", "stderr"];
  const rings: Record<ShellChannel, OutputRing> = {
    stdout: new OutputRing(),
    stderr: new OutputRing(),
  };
  const decoders: Record<ShellChannel, TextDecoder> = {
    stdout: new TextDecoder(),
    stderr: new TextDecoder(),
  };
  let closed = false;
  let spill: WriteStream | undefined;
  let spillPath: string | undefined;
  let spillBytes = 0;

  const append = (channel: ShellChannel, text: string): void => {
    if (text.length > 0) {
      rings[channel].append(text, undefined, RETAIN_BYTES);
    }
  };

  const writeSpill = (text: string): void => {
    if (spill === undefined || text.length === 0) {
      return;
    }
    const bytes = Buffer.byteLength(text, "utf-8");
    if (spillBytes + bytes > MAX_SPILL_BYTES) {
      // 文件已经写不全，撤回路径：交出去会让人以为它是完整输出。
      spill.destroy();
      spill = undefined;
      spillPath = undefined;
      return;
    }
    spillBytes += bytes;
    spill.write(text);
  };

  const sources = channels.map(
    (channel): JobOutputSource => ({
      channel,
      read: (fromByte) => {
        const read = rings[channel].readFrom(fromByte);
        return {
          text: read.chunks.map((chunk) => chunk.text).join(""),
          nextOffset: read.next,
          lossy: read.lossy,
          ...(spillPath === undefined ? {} : { spillPath }),
        };
      },
    })
  );

  return {
    push(channel, chunk) {
      if (closed || chunk.length === 0) {
        return;
      }
      const text = decoders[channel].decode(chunk, { stream: true });
      append(channel, text);
      writeSpill(text);
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const channel of channels) {
        const tail = decoders[channel].decode();
        append(channel, tail);
        writeSpill(tail);
      }
      spill?.end();
      spill = undefined;
    },
    sources,
    spillTo(path) {
      if (closed || spill !== undefined) {
        return;
      }
      try {
        mkdirSync(dirname(path), { recursive: true });
        const stream = createWriteStream(path);
        stream.on("error", () => {
          spill = undefined;
          spillPath = undefined;
        });
        spill = stream;
        spillPath = path;
      } catch {
        spill = undefined;
        spillPath = undefined;
      }
    },
  };
};
