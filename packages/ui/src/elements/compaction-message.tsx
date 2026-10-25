import type { CompactionRecord } from "@workspace/agent-client";
import { ArrowUpRightIcon, Minimize2Icon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "../components/dialog";
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/frame";
import { Marker, MarkerContent, MarkerIcon } from "../components/marker";
import { MessageResponse } from "./message";

export function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

/**
 * 手工压缩在 transcript 里的样子：一条 Marker，点开是装着摘要的弹窗。
 *
 * Marker 说明这一段历史被替换过、省下了多少；摘要太长，不放回行内，点开
 * 在弹窗里读——弹窗里的 Frame 和 assistant turn 里 compaction step 看到的
 * 面板一致。只用在独立的 compaction turn 上。
 */
export function CompactionMessage({ record }: { record?: CompactionRecord }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (!record) {
    return null;
  }

  const trigger = t(`compaction.trigger.${record.trigger}`);
  const tokens = t("compaction.tokens", {
    after: formatTokens(record.tokensAfter),
    before: formatTokens(record.tokensBefore),
  });

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Marker
        className="cursor-pointer select-none rounded-md py-1 outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        render={<DialogTrigger />}
        variant="separator"
      >
        <MarkerIcon>
          <Minimize2Icon className="group-hover/marker:hidden" />
          <ArrowUpRightIcon className="hidden group-hover/marker:block" />
        </MarkerIcon>
        <MarkerContent>
          <span className="group-hover/marker:underline">
            {t("compaction.title")}
          </span>
          <span className="ml-2 text-xs">{trigger}</span>
        </MarkerContent>
        <span className="shrink-0 text-xs tabular-nums">{tokens}</span>
      </Marker>
      <DialogContent
        className="flex h-dvh max-w-none flex-col items-center overflow-y-scroll bg-transparent p-0 py-12 ring-0 sm:max-w-none"
        onClick={(event) => {
          // 全屏的 popup 盖住了 backdrop，“点外面关闭”落空；点到 popup 自己
          // 的空白处，就当作点了遮罩。
          if (event.target === event.currentTarget) {
            setOpen(false);
          }
        }}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{t("compaction.title")}</DialogTitle>
        <div className="my-auto flex min-w-[70dvw] flex-col gap-4 px-5">
          <Frame variant="default" overflowBehavior="scroll">
            <FrameHeader>
              <FrameTitle>
                {t("compaction.title")}
                <span className="ml-2 font-normal text-muted-foreground text-xs">
                  {trigger}
                </span>
              </FrameTitle>
              <span className="text-muted-foreground text-xs">{tokens}</span>
            </FrameHeader>
            <FramePanel>
              <MessageResponse>{record.summary}</MessageResponse>
            </FramePanel>
          </Frame>
        </div>
      </DialogContent>
    </Dialog>
  );
}
