import { SIGN_IN_TOKEN_PARAM } from "@workspace/shared/constants";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * 打开应用前的登录态检查。
 *
 * 三种入口：
 *
 * - 地址栏带 `?token=<登录票据>`：页面自己换 cookie，然后把参数抹掉，用户
 *   看到的就是应用本身，不经过 API 域的跳转。
 * - 已经登录：问一次 `/api/auth/session` 就够。
 * - 都没有：提示去启动时打印的链接。
 *
 * 桌面由主进程注入访问令牌，所以同一份判断对两种文档源都成立。
 */
type SignInStatus =
  | "anonymous"
  | "authenticated"
  | "checking"
  | "expired"
  | "unreachable";

type ExchangeOutcome = "invalid" | "ok" | "unreachable";

/** 启动期 server 可能比页面晚几秒；这个窗口和通道重连的节奏一致。 */
const CHECK_INTERVAL_MS = 500;

const MAX_ATTEMPTS = 20;

/**
 * 问一次 server：这次请求有没有凭据。
 *
 * 网络错误表示“还没连上”，抛出去让调用方重试；明确的 false 才是“需要登录”。
 */
const checkSignIn = async (): Promise<boolean> => {
  const response = await fetch(new URL("api/auth/session", document.baseURI), {
    // cookie 只在同源请求里带；桌面的 aify-app:// 由主进程换成访问令牌。
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`session check failed: ${String(response.status)}`);
  }

  const value: unknown = await response.json();

  return (
    typeof value === "object" &&
    value !== null &&
    "authenticated" in value &&
    value.authenticated === true
  );
};

/** 地址栏里的登录票据。 */
const readSignInToken = (): string | undefined => {
  const ticket = new URL(window.location.href).searchParams
    .get(SIGN_IN_TOKEN_PARAM)
    ?.trim();

  return ticket === undefined || ticket === "" ? undefined : ticket;
};

/** 票据用过就作废，参数也没必要留在历史记录里。 */
const stripSignInToken = (): void => {
  const url = new URL(window.location.href);

  if (!url.searchParams.has(SIGN_IN_TOKEN_PARAM)) {
    return;
  }

  url.searchParams.delete(SIGN_IN_TOKEN_PARAM);
  window.history.replaceState(window.history.state, "", url);
};

const exchangeTicket = async (ticket: string): Promise<ExchangeOutcome> => {
  let response: Response;

  try {
    response = await fetch(new URL("api/auth/login", document.baseURI), {
      body: JSON.stringify({ ticket }),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch {
    return "unreachable";
  }

  if (response.ok) {
    return "ok";
  }

  // 票据本身的问题不该重试：400 缺参数、401 过期或已用、403 来源不对。
  return response.status >= 400 && response.status < 500
    ? "invalid"
    : "unreachable";
};

const exchangeWithRetry = async (ticket: string): Promise<ExchangeOutcome> => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const outcome = await exchangeTicket(ticket);

    if (outcome !== "unreachable") {
      return outcome;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, CHECK_INTERVAL_MS);
    });
  }

  return "unreachable";
};

/**
 * StrictMode 会把 effect 跑两遍。
 *
 * 票据本身可以重复使用，但换两次就建两条登录态、多一次写库。两次共享同一个
 * 结果即可。缓存的是整个重试过程，不是单次请求。
 */
let pendingExchange:
  | { readonly ticket: string; readonly result: Promise<ExchangeOutcome> }
  | undefined;

const exchangeOnce = (ticket: string): Promise<ExchangeOutcome> => {
  if (pendingExchange?.ticket !== ticket) {
    pendingExchange = { result: exchangeWithRetry(ticket), ticket };
  }

  return pendingExchange.result;
};

interface SignInGateProps {
  readonly children: ReactNode;
}

export const SignInGate = ({ children }: SignInGateProps) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SignInStatus>("checking");

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async (): Promise<void> => {
      const ticket = readSignInToken();

      if (ticket !== undefined) {
        const outcome = await exchangeOnce(ticket);

        // 只有确定的结果才抹掉参数；连不上时留着，刷新还能再试。
        if (outcome !== "unreachable") {
          stripSignInToken();
        }

        if (!cancelled) {
          setStatus(
            outcome === "ok"
              ? "authenticated"
              : outcome === "invalid"
                ? "expired"
                : "unreachable"
          );
        }

        return;
      }

      try {
        const authenticated = await checkSignIn();

        if (!cancelled) {
          setStatus(authenticated ? "authenticated" : "anonymous");
        }
      } catch {
        attempts += 1;

        if (attempts >= MAX_ATTEMPTS) {
          if (!cancelled) {
            setStatus("unreachable");
          }

          return;
        }

        timer = setTimeout(() => {
          void run();
        }, CHECK_INTERVAL_MS);
      }
    };

    void run();

    return () => {
      cancelled = true;

      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, []);

  if (status === "authenticated") {
    return children;
  }

  const text = {
    anonymous: {
      hint: t("signIn.requiredHint"),
      title: t("signIn.requiredTitle"),
    },
    checking: { hint: t("signIn.checking"), title: undefined },
    expired: { hint: t("signIn.expiredHint"), title: t("signIn.expiredTitle") },
    unreachable: {
      hint: t("signIn.unreachableHint"),
      title: t("signIn.unreachableTitle"),
    },
  }[status];

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-6 text-center text-foreground">
      <div className="max-w-md space-y-2">
        {text.title === undefined ? null : (
          <p className="text-sm font-medium">{text.title}</p>
        )}
        <p className="text-sm text-muted-foreground">{text.hint}</p>
      </div>
    </div>
  );
};
