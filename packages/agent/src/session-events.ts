import type {
  AgentStreamEvent,
  SessionCursor,
  SessionStreamEvent,
} from "@workspace/agent-client";
import { logger } from "@workspace/shared/logger";
import type { ToolSet } from "ai";

/**
 * 一次运行在通道里的记录。
 *
 * 只留正在跑的这一次：跑完的运行已经写进会话记录，读者要的是它开头到现在的
 * 全部内容，而不是别的运行。
 */
type RunRecord<TOOLS extends ToolSet> = {
  streamId: string;
  /** 领走的那条 user 回合的 id；运行不是由待办项发起时没有。 */
  turnId?: string;
  /** 这条运行的 `run.start` 的序号；重连时先补这一条，再补事件。 */
  startSeq: number;
  events: { seq: number; event: AgentStreamEvent<TOOLS> }[];
  done: boolean;
  failure?: string;
};

type Subscriber<TOOLS extends ToolSet> = {
  send: (event: SessionStreamEvent<TOOLS>) => void;
  fail: (error: unknown) => void;
};

/**
 * 一个会话的事件通道。
 *
 * 运行本来就是一段一段的，而页面要的是「这个会话接下来会发生什么」。把两者
 * 接起来的是这一层：运行开始、事件、运行结束都在这里编号并广播，读者从自己
 * 的游标往后读，跨过运行之间的空档也不会掉线。
 *
 * 通道自己有限的生命周期由注册表管：跑完之后没人听就丢掉，免得一个长期在跑
 * 的服务端为每个见过的会话留一份记录。
 */
class SessionEventChannel<TOOLS extends ToolSet> {
  readonly epoch = crypto.randomUUID();

  #seq = 0;

  #run: RunRecord<TOOLS> | undefined;

  readonly #subscribers = new Set<Subscriber<TOOLS>>();

  /**
   * 这条通道已经收不了尾：没人听，也没有在跑的运行。
   *
   * 之外的任何组合都还可能要交代一次运行，不能丢。
   */
  get isFinished(): boolean {
    const idle = this.#run === undefined || this.#run.done;

    return idle && this.#subscribers.size === 0;
  }

  startRun(streamId: string, turnId?: string): void {
    if (this.#run && !this.#run.done) {
      // 一个会话一次只该跑一次运行。真撞上了，说明前一次的读者再也等不到
      // 它的结尾；把它标成结束，别让它在通道里悬着。
      logger.warn("[session-events] a run started while another was running", {
        previous: this.#run.streamId,
        next: streamId,
      });
      this.endRun(this.#run.streamId, "superseded");
    }

    const seq = this.#next();
    this.#run = {
      done: false,
      events: [],
      startSeq: seq,
      streamId,
      ...(turnId === undefined ? {} : { turnId }),
    };
    this.#broadcast(this.#runStart({ ...this.#run }));
  }

  publish(streamId: string, event: AgentStreamEvent<TOOLS>): void {
    const run = this.#run;
    if (!run || run.done || run.streamId !== streamId) {
      // 不是当前运行的记录：读者要的是这一次，旧的那一次已经写进会话记录。
      return;
    }

    if (event.type === "turn.start") {
      // 与流条目保持一致：新回合取代同一运行里先前缓冲的内容，重放时看不到
      // 半截的旧回合。
      run.events.length = 0;
    }

    const seq = this.#next();
    run.events.push({ event, seq });
    this.#broadcast({ event, seq, streamId, type: "run.event" });
  }

  endRun(streamId: string, failure?: string): void {
    const run = this.#run;
    if (!run || run.streamId !== streamId) {
      return;
    }

    run.done = true;
    run.failure = failure;

    const seq = this.#next();
    this.#broadcast({
      ...(failure === undefined ? {} : { failure }),
      seq,
      streamId,
      type: "run.end",
    });
  }

  /**
   * 从 `since` 之后读到会话的后续。
   *
   * 没有游标、或者游标属于别的通道实例时，只补这一次仍在跑的运行——跑完的
   * 运行已经在会话记录里，重放它等于把同一段内容说两遍。补完不关闭：下一条
   * 运行的 `run.start` 会接着送到这条连接上。
   */
  subscribe(since?: SessionCursor): ReadableStream<SessionStreamEvent<TOOLS>> {
    let subscriber: Subscriber<TOOLS> | undefined;

    return new ReadableStream<SessionStreamEvent<TOOLS>>({
      cancel: () => {
        if (subscriber) {
          this.#subscribers.delete(subscriber);
        }
      },
      start: (controller) => {
        const live = this.#run?.done === false ? this.#run : undefined;

        // 重放从哪一条之后开始。`ready` 报的就是这个下界，此后送出的每条事件
        // 序号都比它大——把它当游标的读者既不会重复，也不会漏。
        const after =
          since?.epoch === this.epoch
            ? since.seq
            : live === undefined
              ? this.#seq
              : live.startSeq - 1;

        controller.enqueue({ epoch: this.epoch, seq: after, type: "ready" });

        if (live) {
          controller.enqueue(this.#runStart(live));

          for (const buffered of live.events) {
            if (buffered.seq > after) {
              controller.enqueue({
                event: buffered.event,
                seq: buffered.seq,
                streamId: live.streamId,
                type: "run.event",
              });
            }
          }
        }

        const self: Subscriber<TOOLS> = {
          fail: (error) => {
            try {
              controller.error(error);
            } catch {
              // 已经关掉了。
            }
          },
          send: (event) => {
            try {
              controller.enqueue(event);
            } catch {
              // 读者走了，别再往里写。
              this.#subscribers.delete(self);
            }
          },
        };

        subscriber = self;
        this.#subscribers.add(self);
      },
    });
  }

  /**
   * 一次运行的开始信封。
   *
   * 同一条运行说两遍：开跑时广播一次，重放时再补一次。两处的字段必须一致，
   * 所以只在这里造。
   */
  #runStart(run: RunRecord<TOOLS>): SessionStreamEvent<TOOLS> {
    return {
      seq: run.startSeq,
      streamId: run.streamId,
      type: "run.start",
      ...(run.turnId === undefined ? {} : { turnId: run.turnId }),
    };
  }

  #next(): number {
    this.#seq += 1;
    return this.#seq;
  }

  #broadcast(event: SessionStreamEvent<TOOLS>): void {
    for (const subscriber of this.#subscribers) {
      subscriber.send(event);
    }
  }
}

/**
 * 一个进程里所有会话的事件通道。
 *
 * 运行开始与结束由 {@link StreamEventRegistry} 转达：那两处正好是一次运行的
 * 边界，而事件本身也从那里流过，所以不需要第二个观察点。
 */
export class SessionEventRegistry<TOOLS extends ToolSet = ToolSet> {
  readonly #channels = new Map<string, SessionEventChannel<TOOLS>>();

  startRun(sessionId: string, streamId: string, turnId?: string): void {
    this.#channelFor(sessionId).startRun(streamId, turnId);
  }

  publish(
    sessionId: string,
    streamId: string,
    event: AgentStreamEvent<TOOLS>
  ): void {
    this.#channels.get(sessionId)?.publish(streamId, event);
  }

  endRun(sessionId: string, streamId: string, failure?: string): void {
    const channel = this.#channels.get(sessionId);
    if (!channel) {
      return;
    }

    channel.endRun(streamId, failure);

    // 没人听、也没有在跑的运行：这条通道之后只会从下一次运行重新开始，留着
    // 它就是给每个见过的会话留一份记录。
    if (channel.isFinished) {
      this.#channels.delete(sessionId);
    }
  }

  subscribe(
    sessionId: string,
    since?: SessionCursor
  ): ReadableStream<SessionStreamEvent<TOOLS>> {
    return this.#channelFor(sessionId).subscribe(since);
  }

  #channelFor(sessionId: string): SessionEventChannel<TOOLS> {
    const existing = this.#channels.get(sessionId);
    if (existing) {
      return existing;
    }

    const channel = new SessionEventChannel<TOOLS>();
    this.#channels.set(sessionId, channel);

    return channel;
  }
}

export const SESSION_EVENTS = new SessionEventRegistry();
