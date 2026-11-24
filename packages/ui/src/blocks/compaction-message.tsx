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
import { Marker, MarkerContent, MarkerIcon } from "../components/marker";
import { MessageResponse } from "./message";
import { RenderedSection } from "./tool-panels";

export function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

/**
 * 手工压缩在会话记录里的样子：一条 Marker，点开是装着摘要的弹窗。
 *
 * The marker says this stretch of history was replaced and how much it freed.
 * The summary is too long for the row, so it opens in a dialog — in the same
 * card the inline compaction step uses. Used on a compaction turn of its own.
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
  const detail = `${trigger} · ${tokens}`;

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
          <RenderedSection
            label={
              <>
                {t("compaction.title")}
                <span className="ml-2 font-sans font-normal text-muted-foreground text-xs normal-case tracking-normal">
                  {detail}
                </span>
              </>
            }
          >
            <MessageResponse>{record.summary}</MessageResponse>
          </RenderedSection>
        </div>
      </DialogContent>
    </Dialog>
  );
}
