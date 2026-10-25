import type { JobAppendOptions, JobOutputSource } from "./types";

/** 一次泵送；`done` 在结算后的最后一次抽干完成时 resolve。 */
export type PumpHandle = {
  done: Promise<void>;
};

/** 泵把读到的东西送到哪里。 */
export type PumpSink = {
  /**
   * 把复制到的文本追加到输出环。
   * @param text - 按原样读到的块文本。
   * @param options - 流标签与丢失标记。
   */
  append(text: string, options?: JobAppendOptions): void;
  /**
   * 记录源 `index` 在最近一次读取里报告的完整流文件；每次读取都会调用，
   * 源没有或撤回了就传 `undefined`。
   * @param index - 源在泵的数组里的位置。
   * @param path - 源报告的宿主路径。
   */
  spill(index: number, path: string | undefined): void;
};

/**
 * 注册表拥有的拉取泵：按固定节奏把任务的拉取源复制进输出环，并在生产方
 * 结算后再抽干一次，保证结算裁剪之前环里已经有全部字节。
 *
 * 每轮按数组顺序抽干，所以两个源在一个轮询窗口里产出的字节按这个顺序落盘，
 * 而不是按实际写入顺序：环是一份尽力而为的实时视图，跨源乱序不超过 `pollMs`。
 *
 * 不管任务跑多久，等待都只占固定资源：整轮只有一次 `until` 订阅，同一时刻
 * 只有一个挂着的定时器。
 * @param sources - 生产方的流，各自维护自己的偏移。
 * @param sink - 接收每个复制块和每个源当前的完整流文件。
 * @param pollMs - 轮询间隔，正有限数。
 * @param until - 生产方结束（或被销毁）时结算；只用到它的 `then`。
 */
export const startPump = (
  sources: readonly JobOutputSource[],
  sink: PumpSink,
  pollMs: number,
  until: PromiseLike<unknown>
): PumpHandle => {
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(
      `invalid pump pollMs: expected a positive finite number of milliseconds, got ${JSON.stringify(pollMs)}`
    );
  }

  const states = sources.map((source) => ({ source, cursor: 0 }));

  const drain = (): void => {
    for (const [index, state] of states.entries()) {
      const read = state.source.read(state.cursor);
      state.cursor = read.nextOffset;
      sink.spill(index, read.spillPath);
      if (read.text.length === 0) {
        continue;
      }
      const { channel } = state.source;
      if (channel === undefined && !read.lossy) {
        sink.append(read.text);
      } else {
        sink.append(read.text, {
          ...(channel === undefined ? {} : { channel }),
          ...(read.lossy ? { gapBefore: true as const } : {}),
        });
      }
    }
  };

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;

  const finish = (): void => {
    settled = true;
    // 立刻清掉挂着的轮询，并释放当前的等待，让最后一次抽干马上开始。
    clearTimeout(timer);
    wake?.();
  };

  /** 等一个轮询间隔，或者被 `finish` 提前叫醒。 */
  const tick = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, pollMs);
    });

  const done = (async (): Promise<void> => {
    void Promise.resolve(until).then(finish, finish);
    // 条件写在循环体里：`settled` 只由 `until` 的回调改写，把它写进 while
    // 条件会让静态检查误判成循环里没有修改、因而永不退出。
    for (;;) {
      drain();
      await tick();
      wake = undefined;
      timer = undefined;
      if (settled) {
        break;
      }
    }
    drain();
  })();

  return { done };
};
