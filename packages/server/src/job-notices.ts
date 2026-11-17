import { composeJobNotice } from "@workspace/agent";
import type {
  AgentRunner,
  JobId,
  JobNoticeAdapter,
  JobRegistry,
} from "@workspace/agent";
import { JOB_NOTICE_INBOX_KIND } from "@workspace/agent-client";
import { logger } from "@workspace/shared/logger";

/** 适配器只依赖删除待办项这一项存储能力。 */
type NoticeStore = {
  deleteInboxItems(sessionId: string, ids?: readonly string[]): Promise<number>;
};

/** 投递与撤回完成通知。 */
export type JobNoticeAdapterDeps = {
  registry: JobRegistry;
  runner: AgentRunner;
  store: NoticeStore;
};

/**
 * 把注册表的结算转成收件箱里的完成通知。
 *
 * 投递是异步的：结算事件是同步的，不能等数据库。入队还没落地时模型就自己
 * 读走了这个任务，通知会被撤回，而不是稍后重复送达。
 * @param deps - 注册表、运行器与存储。
 */
export const createJobNoticeAdapter = ({
  registry,
  runner,
  store,
}: JobNoticeAdapterDeps): JobNoticeAdapter => {
  /** 已经入队、还没被领取的通知，按任务 id 索引。 */
  const pending = new Map<JobId, { sessionId: string; itemId: string }>();
  /** 正在入队的任务；这期间被撤回的通知要在落地后删掉。 */
  const inFlight = new Set<JobId>();
  const withdrawn = new Set<JobId>();

  const remove = (sessionId: string, itemId: string): void => {
    void store.deleteInboxItems(sessionId, [itemId]).catch((error: unknown) => {
      logger.warn(`job-notices: failed to withdraw a notice: ${String(error)}`);
    });
  };

  /** 通知带走了未读输出：把模型游标推过去。失败只记日志，字节留在任务里。 */
  const commitNoticeOutput = (sessionId: string, jobId: JobId): void => {
    try {
      registry.read(jobId, sessionId);
    } catch (error: unknown) {
      logger.warn(
        `job-notices: failed to consume the output of ${jobId}: ${String(error)}`
      );
    }
  };

  return {
    deliver(job) {
      const sessionId = job.owner;
      if (sessionId === undefined) {
        // 无主任务没有会话可送达。
        return;
      }
      // 先确认这条通知投得出去，再落实消耗未读输出：中间任何一步失败（会话
      // 没有模型、入队失败、模型自己先读走），游标都留在原处，模型之后照常
      // 读得到这些字节。
      if (!runner.canDeliverNotice(sessionId)) {
        return;
      }

      let notice: ReturnType<typeof composeJobNotice>;
      try {
        const preview = registry.peek(job.id, sessionId);
        notice = composeJobNotice({ job, readOutput: () => preview });
      } catch (error: unknown) {
        logger.warn(
          `job-notices: failed to compose a notice for ${job.id}: ${String(error)}`
        );
        return;
      }

      inFlight.add(job.id);
      void runner
        .enqueueNotice({
          sessionId,
          text: notice.text,
          dedupeKey: `${JOB_NOTICE_INBOX_KIND}:${job.id}`,
        })
        .then((item) => {
          inFlight.delete(job.id);
          if (item === undefined) {
            return;
          }
          if (withdrawn.delete(job.id)) {
            // 入队期间模型已经自己读走了：通知不必再出现。
            remove(sessionId, item.id);
            return;
          }
          // 通知真的落库了，现在才把游标推过去。摘要类通知没有消费正文，
          // 不用落实。
          if (notice.inline) {
            commitNoticeOutput(sessionId, job.id);
          }
          pending.set(job.id, { sessionId, itemId: item.id });
        })
        .catch((error: unknown) => {
          inFlight.delete(job.id);
          logger.warn(
            `job-notices: failed to deliver a notice for ${job.id}: ${String(error)}`
          );
        });
    },

    withdraw(jobId) {
      const entry = pending.get(jobId);
      if (entry !== undefined) {
        pending.delete(jobId);
        remove(entry.sessionId, entry.itemId);
        return;
      }
      if (inFlight.has(jobId)) {
        withdrawn.add(jobId);
      }
    },
  };
};
