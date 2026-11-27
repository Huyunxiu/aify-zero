import type { JobRead, JobView } from "@workspace/agent";
import { describe, expect, test, vi } from "vitest";

import { createJobNoticeAdapter } from "../src/job-notices.js";

const view = (overrides: Partial<JobView> = {}): JobView => ({
  id: "bash-1",
  kind: "bash",
  label: "sleep 1",
  owner: "s1",
  status: "completed",
  detail: "exit code: 0",
  startedAt: 1,
  finishedAt: 2,
  output: { total: 4, earliest: 0, unreadBytes: 4 },
  ...overrides,
});

const read = (): JobRead => ({
  chunks: [{ at: 0, text: "out!" }],
  lossy: false,
  job: view(),
});

type NoticeItem = ReturnType<typeof item>;
type EnqueueNotice = (input: {
  sessionId: string;
  text: string;
  dedupeKey: string;
}) => Promise<NoticeItem | undefined>;
type DeleteItems = (
  sessionId: string,
  ids?: readonly string[]
) => Promise<number>;

const item = (sessionId = "s1") => ({
  seq: 0,
  id: "item-1",
  sessionId,
  kind: "job-notice" as const,
  dedupeKey: "job-notice:bash-1",
  deliverAt: "run-boundary" as const,
  content: {
    id: "turn-1",
    type: "user" as const,
    createdAt: 1,
    status: "done" as const,
    content: [],
  },
  payload: { model: { providerId: "p", modelId: "m" } },
  createdAt: 1,
});

/** The writer as this adapter uses it: one question, one way to write. */
const writer = (write: EnqueueNotice, canDeliver = true): never =>
  ({
    write,
    canDeliver: () => canDeliver,
    resetBudget: () => {},
  }) as never;

describe(createJobNoticeAdapter, () => {
  test("composes the notice and enqueues it for the owner", async () => {
    const enqueueNotice = vi.fn<EnqueueNotice>().mockResolvedValue(item());
    const deleteInboxItems = vi.fn<DeleteItems>().mockResolvedValue(1);
    const adapter = createJobNoticeAdapter({
      registry: { peek: read, read } as never,
      notices: writer(enqueueNotice),
      store: { deleteInboxItems },
    });

    adapter.deliver(view());

    await vi.waitFor(() => expect(enqueueNotice).toHaveBeenCalledOnce());
    const input = enqueueNotice.mock.calls[0]?.[0] as {
      sessionId: string;
      text: string;
    };
    expect(input.sessionId).toBe("s1");
    expect(input.text).toContain("background job bash-1");
    expect(input.text).toContain("out!");
  });

  test("withdraws a notice that is still pending", async () => {
    const enqueueNotice = vi.fn<EnqueueNotice>().mockResolvedValue(item());
    const deleteInboxItems = vi.fn<DeleteItems>().mockResolvedValue(1);
    const adapter = createJobNoticeAdapter({
      registry: { peek: read, read } as never,
      notices: writer(enqueueNotice),
      store: { deleteInboxItems },
    });

    adapter.deliver(view());
    await vi.waitFor(() => expect(enqueueNotice).toHaveBeenCalledOnce());
    adapter.withdraw("bash-1");

    await vi.waitFor(() =>
      expect(deleteInboxItems).toHaveBeenCalledWith("s1", ["item-1"])
    );
  });

  test("deletes a notice that was withdrawn while enqueueing", async () => {
    let resolveItem!: (value: NoticeItem) => void;
    const enqueueNotice = vi.fn<EnqueueNotice>().mockReturnValue(
      new Promise((resolve) => {
        resolveItem = resolve;
      })
    );
    const deleteInboxItems = vi.fn<DeleteItems>().mockResolvedValue(1);
    const adapter = createJobNoticeAdapter({
      registry: { peek: read, read } as never,
      notices: writer(enqueueNotice),
      store: { deleteInboxItems },
    });

    adapter.deliver(view());
    adapter.withdraw("bash-1");
    resolveItem(item());

    await vi.waitFor(() =>
      expect(deleteInboxItems).toHaveBeenCalledWith("s1", ["item-1"])
    );
  });

  test("skips a session that cannot receive a notice, before reading output", () => {
    const enqueueNotice = vi.fn<EnqueueNotice>();
    const readJob = vi.fn<(id: string, caller?: string) => JobRead>(() =>
      read()
    );
    const adapter = createJobNoticeAdapter({
      registry: { peek: readJob, read: readJob } as never,
      notices: writer(enqueueNotice, false),
      store: { deleteInboxItems: vi.fn<DeleteItems>() },
    });

    adapter.deliver(view());

    expect(readJob).not.toHaveBeenCalled();
    expect(enqueueNotice).not.toHaveBeenCalled();
  });

  test("does nothing for an unowned job", () => {
    const enqueueNotice = vi.fn<EnqueueNotice>();
    const adapter = createJobNoticeAdapter({
      registry: { peek: read, read } as never,
      notices: writer(enqueueNotice),
      store: { deleteInboxItems: vi.fn<DeleteItems>() },
    });

    adapter.deliver(view({ owner: undefined }));

    expect(enqueueNotice).not.toHaveBeenCalled();
  });

  // 未读输出只在通知真的落库之后才被消费。入队失败、或者模型抢先自己读走，
  // 游标都必须留在原处，否则那几个字节谁都看不到了。
  test("keeps the unread output when enqueueing fails", async () => {
    const peek = vi.fn<(id: string, caller?: string) => JobRead>(() => read());
    const commit = vi.fn<(id: string, caller?: string) => JobRead>(() =>
      read()
    );
    const enqueueNotice = vi
      .fn<EnqueueNotice>()
      .mockRejectedValue(new Error("the store is down"));
    const adapter = createJobNoticeAdapter({
      registry: { peek, read: commit } as never,
      notices: writer(enqueueNotice),
      store: { deleteInboxItems: vi.fn<DeleteItems>() },
    });

    adapter.deliver(view());

    await vi.waitFor(() => expect(enqueueNotice).toHaveBeenCalledOnce());
    expect(peek).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  test("keeps the unread output when the model withdraws the notice", async () => {
    let resolveItem!: (value: NoticeItem) => void;
    const peek = vi.fn<(id: string, caller?: string) => JobRead>(() => read());
    const commit = vi.fn<(id: string, caller?: string) => JobRead>(() =>
      read()
    );
    const enqueueNotice = vi.fn<EnqueueNotice>().mockReturnValue(
      new Promise((resolve) => {
        resolveItem = resolve;
      })
    );
    const deleteInboxItems = vi.fn<DeleteItems>().mockResolvedValue(1);
    const adapter = createJobNoticeAdapter({
      registry: { peek, read: commit } as never,
      notices: writer(enqueueNotice),
      store: { deleteInboxItems },
    });

    adapter.deliver(view());
    adapter.withdraw("bash-1");
    resolveItem(item());

    await vi.waitFor(() =>
      expect(deleteInboxItems).toHaveBeenCalledWith("s1", ["item-1"])
    );
    expect(commit).not.toHaveBeenCalled();
  });

  test("consumes the unread output once the notice lands", async () => {
    const peek = vi.fn<(id: string, caller?: string) => JobRead>(() => read());
    const commit = vi.fn<(id: string, caller?: string) => JobRead>(() =>
      read()
    );
    const enqueueNotice = vi.fn<EnqueueNotice>().mockResolvedValue(item());
    const adapter = createJobNoticeAdapter({
      registry: { peek, read: commit } as never,
      notices: writer(enqueueNotice),
      store: { deleteInboxItems: vi.fn<DeleteItems>() },
    });

    adapter.deliver(view());

    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    // 先预看组正文，落库之后再落实消耗：同一个任务、同一个会话。
    expect(peek).toHaveBeenCalledWith("bash-1", "s1");
    expect(commit).toHaveBeenCalledWith("bash-1", "s1");
  });
});
