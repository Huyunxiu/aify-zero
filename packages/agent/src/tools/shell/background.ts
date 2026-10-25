import { OutputRing } from "../../jobs/ring";
import type { JobOutputSource } from "../../jobs/types";
import type { ShellChannel } from "./output";

/** 单条流在后台任务里保留的输出上限，和注册表运行期的环同一个量级。 */
const RETAIN_BYTES = 256 * 1024;

/**
 * 后台命令的输出缓冲：每条流一个输出环，按 UTF-8 字节记住最近的输出。
 *
 * 它不是模型的读取端——模型的读取由注册表的环负责；这里只是注册表拉取源
 * 背后的生产者侧缓冲，两者都按绝对偏移提供非消耗读取。
 */
export type ShellStreamBuffer = {
  /** 喂入一块原始字节；解码跨块拼接，不会切坏多字节字符。 */
  push(channel: ShellChannel, chunk: Buffer): void;
  /** 结束解码，把解码器里剩下的尾巴写进环；之后不再接受写入。 */
  close(): void;
  /** 注册表要拉取的两个源，stdout 在前。 */
  sources: readonly JobOutputSource[];
};

/**
 * 建一个后台命令的输出缓冲。
 * @returns 生产者侧的写入面和两个拉取源。
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

  const append = (channel: ShellChannel, text: string): void => {
    if (text.length > 0) {
      rings[channel].append(text, undefined, RETAIN_BYTES);
    }
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
        };
      },
    })
  );

  return {
    push(channel, chunk) {
      if (closed || chunk.length === 0) {
        return;
      }
      append(channel, decoders[channel].decode(chunk, { stream: true }));
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const channel of channels) {
        append(channel, decoders[channel].decode());
      }
    },
    sources,
  };
};
