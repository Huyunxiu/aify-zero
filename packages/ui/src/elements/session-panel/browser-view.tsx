/**
 * 会话面板里的浏览器视图。
 *
 * 页面本身不在 DOM 里：主进程用 `WebContentsView` 托管，浮在窗口上。渲染端
 * 只提供一个占位元素——测它的矩形、按可见性规则上报，原生视图就会落在上面。
 * 面板开合动画和模态浮层期间先把视图藏起来，结束再补一次矩形并显示，避免
 * 原生层和 DOM 动画错位。
 */
import {
  emptyBrowserState,
  parseBrowserUrlRejection,
} from "@workspace/shared/browser-protocol";
import type { BrowserBounds } from "@workspace/shared/browser-protocol";
import { getErrorMessage } from "@workspace/shared/errors";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { useBrowserOccluded } from "@workspace/ui/lib/browser-occlusion";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  LoaderCircleIcon,
  RotateCwIcon,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { applyBrowserFrame, projectBrowserFrame } from "./browser-frame";
import type { BrowserFrame } from "./browser-frame";
import { getBrowserRuntime } from "./browser-runtime";

export type BrowserViewProps = {
  /** 当前标签是否可见，并且面板没有收起。 */
  readonly active: boolean;
  /** 面板开合动画是否结束；结束时才显示原生视图。 */
  readonly animationSettled: boolean;
  readonly onTitleChange: (title: string | null) => void;
  readonly projectId: string | null;
  /** 会话行是否已经读回；项目 id 未定时先不建视图，免得档案范围选错。 */
  readonly projectResolved: boolean;
  readonly sessionId: string;
  /** 标签 id 就是视图 id。 */
  readonly viewId: string;
};

const ZERO_BOUNDS: BrowserBounds = { height: 0, width: 0, x: 0, y: 0 };

/**
 * 把主进程的错误信息换成能读的一句话。
 *
 * @param message - 导航失败的错误信息。
 * @param t - 翻译函数。
 * @returns 拒绝原因对应的文案；其他错误原样返回。
 */
function describeNavigationError(
  message: string,
  t: (key: string) => string
): string {
  const reason = parseBrowserUrlRejection(message);

  return reason === null ? message : t(`browser.rejected.${reason}`);
}

export function BrowserView({
  active,
  animationSettled,
  onTitleChange,
  projectId,
  projectResolved,
  sessionId,
  viewId,
}: BrowserViewProps) {
  const { t } = useTranslation();
  const runtime = React.useMemo(getBrowserRuntime, []);
  const occluded = useBrowserOccluded();
  const placeholderRef = React.useRef<HTMLDivElement>(null);
  const boundsRef = React.useRef<BrowserBounds | null>(null);
  const appliedRef = React.useRef<BrowserFrame | null>(null);
  const [bounds, setBounds] = React.useState<BrowserBounds | null>(null);
  const [state, setState] = React.useState(emptyBrowserState);
  const [draft, setDraft] = React.useState("");
  const [addressFocused, setAddressFocused] = React.useState(false);
  const [navigationError, setNavigationError] = React.useState<string | null>(
    null
  );

  // 视图的档案范围在创建时确定；项目查询晚到也不能重建视图。
  const [scope] = React.useState(() => ({ projectId, sessionId }));

  const measure = React.useCallback((): void => {
    const element = placeholderRef.current;

    if (element === null) {
      boundsRef.current = null;
      setBounds(null);

      return;
    }

    const rect = element.getBoundingClientRect();
    const next = {
      height: rect.height,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    };

    boundsRef.current = next;
    setBounds(next);
  }, []);

  // 占位元素的尺寸和位置都要跟：分栏拖拽、窗口缩放、面板动画都会改它。
  React.useEffect(() => {
    const element = placeholderRef.current;

    if (element === null) {
      return;
    }

    let frame = 0;
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);

    observer.observe(element);
    window.addEventListener("resize", schedule);
    measure();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [measure]);

  // 标签挂载时创建视图，关闭时销毁；页面生命周期跟着标签走。
  React.useEffect(() => {
    if (runtime === null || !projectResolved) {
      return;
    }

    let disposed = false;

    // 新建的视图总是隐藏的。StrictMode 会销毁再建一次，上一只视图的
    // 「已显示」不能带到新视图上，否则新视图再也不会收到显示命令。
    appliedRef.current = null;

    runtime
      .create({
        bounds: boundsRef.current ?? ZERO_BOUNDS,
        id: viewId,
        projectId: scope.projectId,
        sessionId: scope.sessionId,
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setNavigationError(getErrorMessage(error) ?? String(error));
        }
      });

    return () => {
      disposed = true;
      appliedRef.current = null;
      runtime.destroy(viewId);
    };
  }, [projectResolved, runtime, scope, viewId]);

  // 导航状态只接受自己这个视图的事件。
  React.useEffect(() => {
    if (runtime === null) {
      return;
    }

    return runtime.subscribe((event) => {
      if (event.id !== viewId) {
        return;
      }

      setState(event.state);
      onTitleChange(event.state.title === "" ? null : event.state.title);
    });
  }, [onTitleChange, runtime, viewId]);

  // 面板动画刚结束时布局才落定：再量一次，保证显示前矩形是最终的。
  React.useEffect(() => {
    if (animationSettled) {
      measure();
    }
  }, [animationSettled, measure]);

  const frame = React.useMemo(
    () =>
      projectBrowserFrame({
        active,
        animationSettled,
        bounds,
        occluded,
      }),
    [active, animationSettled, bounds, occluded]
  );

  React.useEffect(() => {
    if (runtime === null) {
      return;
    }

    appliedRef.current = applyBrowserFrame(
      runtime,
      viewId,
      appliedRef.current,
      frame
    );
  }, [frame, runtime, viewId]);

  // 地址栏不抢用户的输入：失焦时才跟随页面地址。
  React.useEffect(() => {
    if (!addressFocused) {
      setDraft(state.url);
    }
  }, [addressFocused, state.url]);

  const navigate = React.useCallback(async (): Promise<void> => {
    if (runtime === null) {
      return;
    }

    setNavigationError(null);

    try {
      await runtime.navigate(viewId, draft);
    } catch (error) {
      setNavigationError(getErrorMessage(error) ?? String(error));
    }
  }, [draft, runtime, viewId]);

  const startNavigation = (action: "back" | "forward" | "reload"): void => {
    if (runtime === null) {
      return;
    }

    setNavigationError(null);
    runtime[action](viewId);
  };

  if (runtime === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-md text-center text-muted-foreground text-sm">
          {t("browser.desktopOnly")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <Button
          aria-label={t("browser.back")}
          disabled={!state.canGoBack}
          onClick={() => {
            startNavigation("back");
          }}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <Button
          aria-label={t("browser.forward")}
          disabled={!state.canGoForward}
          onClick={() => {
            startNavigation("forward");
          }}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowRightIcon className="size-4" />
        </Button>
        <Button
          aria-label={t("browser.reload")}
          disabled={state.url === ""}
          onClick={() => {
            startNavigation("reload");
          }}
          size="icon-sm"
          variant="ghost"
        >
          <RotateCwIcon className="size-4" />
        </Button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            void navigate();
          }}
        >
          <Input
            aria-label={t("browser.address")}
            className="h-7 text-xs"
            onBlur={() => {
              setAddressFocused(false);
            }}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onFocus={(event) => {
              setAddressFocused(true);
              event.currentTarget.select();
            }}
            placeholder={t("browser.addressPlaceholder")}
            spellCheck={false}
            value={draft}
          />
        </form>
        {state.loading && (
          <LoaderCircleIcon
            aria-label={t("browser.loading")}
            className="size-4 shrink-0 animate-spin text-muted-foreground"
          />
        )}
      </div>
      {navigationError !== null && (
        <p
          aria-live="polite"
          className="shrink-0 border-b px-3 py-1 text-destructive text-xs"
        >
          {describeNavigationError(navigationError, t)}
        </p>
      )}
      {/* 原生视图落在这一块上；元素本身只负责量尺寸。 */}
      <div
        className="relative min-h-0 flex-1 bg-background"
        ref={placeholderRef}
      />
    </div>
  );
}
