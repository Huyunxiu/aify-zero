import type { ToolSet } from "ai";

import type { AgentStreamEvent, AgentUserTurn } from "./types";

/**
 * 会话事件流上的一条事件。
 *
 * 传输按会话进行，不按运行：一个会话会接连跑很多次运行，页面只需要一条连接
 * 就能看到接下来的每一次。运行仍然自成一段——`run.start` 到 `run.end` 之间
 * 的事件都属于同一次运行。
 *
 * `epoch` 认出这条通道的实例（服务端进程重启、通道重建都会换一个），`seq`
 * 是这条会话上单调递增的序号。两者合起来是断线重连的游标：带上最后读到的
 * 游标重连，服务端从下一条接着发，客户端不必重放已经看过的内容。
 */
export type SessionStreamEvent<TOOLS extends ToolSet> =
  | {
      type: "ready";
      epoch: string;
      /** 连接建立时的序号；之后每条事件的 `seq` 都比它大。 */
      seq: number;
    }
  | {
      type: "run.start";
      seq: number;
      streamId: string;
      /**
       * 这一次运行领走的待办项里那条 user 回合的 id。
       *
       * 页面靠它把「排队中的消息」认成「已经开始的回合」：一条待办项被领走
       * 时从队列里消失，同时以 user 回合的身份出现在会话记录里。
       */
      turnId?: string;
      /**
       * 那条回合的内容。
       *
       * 会话里的 user 回合不都是读者发的：后台任务的完成通知由运行器自己投递，
       * 读者既没发过它，也来不及在收件箱里看见它。带上内容，读者不必回读会话
       * 记录就能把它接进记录。
       */
      turn?: AgentUserTurn;
    }
  | {
      type: "run.event";
      seq: number;
      streamId: string;
      event: AgentStreamEvent<TOOLS>;
    }
  | {
      type: "run.end";
      seq: number;
      streamId: string;
      /** 运行以失败收尾时的原因；正常结束没有这个字段。 */
      failure?: string;
    };

/** 断线重连的游标：通道实例加序号。 */
export type SessionCursor = {
  epoch: string;
  seq: number;
};

/** 游标的传输形式，`<epoch>:<seq>`。 */
export function formatSessionCursor({ epoch, seq }: SessionCursor): string {
  return `${epoch}:${seq}`;
}

/**
 * 解析游标。认不出的写法当作没有游标：重连的人会多读一遍，而不是少读一段。
 */
export function parseSessionCursor(value: string): SessionCursor | undefined {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) {
    return undefined;
  }

  const seq = Number(value.slice(separator + 1));
  if (!Number.isSafeInteger(seq) || seq < 0) {
    return undefined;
  }

  return { epoch: value.slice(0, separator), seq };
}
