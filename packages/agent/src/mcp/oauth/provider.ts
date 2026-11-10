import { randomBytes } from "node:crypto";

import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthTokens,
} from "@ai-sdk/mcp";

import type { McpCredentialStore } from "./store";

/** 存在 `verifier` 一栏里的东西：PKCE 与 state 是同一次授权的两半。 */
type StoredVerifier = {
  codeVerifier?: string;
  state?: string;
};

export type McpOAuthProviderOptions = {
  serverId: string;
  store: McpCredentialStore;
  /** 浏览器回跳地址；agent 不知道自己的端口，由宿主给出。 */
  redirectUrl: string;
  clientName?: string;
  /** 记下 `state`，供回环回调找回流程。 */
  onState?: (state: string) => void;
};

const STATE_BYTES = 32;

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * 把配置、存储与回环地址拼成一个 `OAuthClientProvider`。
 *
 * 只做存取与校验，不自己打开浏览器：授权地址留在 `authorizationUrl` 上，由
 * 管理器读走交给界面。这样「谁来开浏览器」是一个决定，不是副作用。
 */
export class McpOAuthProvider implements OAuthClientProvider {
  readonly #serverId: string;
  readonly #store: McpCredentialStore;
  readonly #clientName: string;
  readonly #onState?: (state: string) => void;
  readonly redirectUrl: string;

  /** 最近一次生成的授权地址；管理器在 401 之后读它。 */
  authorizationUrl?: URL;

  constructor(options: McpOAuthProviderOptions) {
    this.#serverId = options.serverId;
    this.#store = options.store;
    this.redirectUrl = options.redirectUrl;
    this.#clientName = options.clientName ?? "Aify Zero";
    this.#onState = options.onState;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const record = await this.#store.read<OAuthTokens>(
      this.#serverId,
      "tokens"
    );

    return record?.value;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.#store.write(this.#serverId, "tokens", tokens);
  }

  /**
   * 授权地址不在这里打开。
   *
   * 传输层在 401 之后调到这一步，如果这里直接拉起浏览器，后台回合也会抢
   * 焦点。真实用户手势只有设置页那一次点击。
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const stored = await this.#storedVerifier();
    await this.#store.write(this.#serverId, "verifier", {
      ...stored,
      codeVerifier,
    } satisfies StoredVerifier);
  }

  async codeVerifier(): Promise<string> {
    const stored = await this.#storedVerifier();
    if (stored.codeVerifier === undefined) {
      throw new Error("No PKCE code verifier is stored for this server");
    }

    return stored.codeVerifier;
  }

  state(): string {
    return randomBytes(STATE_BYTES).toString("base64url");
  }

  async saveState(state: string): Promise<void> {
    const stored = await this.#storedVerifier();
    await this.#store.write(this.#serverId, "verifier", {
      ...stored,
      state,
    } satisfies StoredVerifier);
    this.#onState?.(state);
  }

  async storedState(): Promise<string | undefined> {
    const stored = await this.#storedVerifier();

    return stored.state;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.#clientName,
      redirect_uris: [this.redirectUrl],
      // 公开客户端：没有 secret，安全性由 PKCE 提供。
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const record = await this.#store.read<OAuthClientInformation>(
      this.#serverId,
      "client"
    );

    return record?.value;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformation
  ): Promise<void> {
    await this.#store.write(this.#serverId, "client", clientInformation);
  }

  /**
   * 我们只会写动态注册拿到的 client，所以「有记录」就等于「是注册来的」。
   *
   * SDK 靠这个判断 `invalid_client` 之后要不要连注册信息一起丢掉。
   */
  async isClientInformationDynamicallyRegistered(): Promise<boolean> {
    return (await this.clientInformation()) !== undefined;
  }

  /**
   * 按 SDK 给的 scope 删凭据。
   *
   * 令牌只在代次没变时删：并发刷新换来的新令牌不能被一次晚到的失效清掉。
   */
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier",
    context?: { tokens: OAuthTokens }
  ): Promise<void> {
    if (scope === "tokens" || scope === "all") {
      const stored = await this.#store.read<OAuthTokens>(
        this.#serverId,
        "tokens"
      );
      if (
        stored !== undefined &&
        (context === undefined || sameTokens(stored.value, context.tokens))
      ) {
        await this.#store.delete(this.#serverId, "tokens", stored.generation);
      }
    }

    if (scope === "client" || scope === "all") {
      await this.#store.delete(this.#serverId, "client");
    }

    if (scope === "verifier" || scope === "all") {
      await this.#store.delete(this.#serverId, "verifier");
    }
  }

  /**
   * 只信 https 与回环。
   *
   * 资源服务器可以把我们指向它选定的授权服务器；没有这一条，一个坏掉的
   * MCP 服务器就能让我们把浏览器送到任意主机。
   */
  validateAuthorizationServerURL(
    _serverUrl: string | URL,
    authorizationServerUrl: string | URL
  ): void {
    const parsed = new URL(String(authorizationServerUrl));

    if (parsed.protocol === "https:") {
      return;
    }

    if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
      return;
    }

    throw new Error(
      `Authorization server must use https, got ${parsed.origin}: ${parsed.protocol}`
    );
  }

  async #storedVerifier(): Promise<StoredVerifier> {
    const record = await this.#store.read<StoredVerifier>(
      this.#serverId,
      "verifier"
    );

    return record?.value ?? {};
  }
}

/** 两份令牌是不是同一次发下来的。 */
function sameTokens(a: OAuthTokens, b: OAuthTokens): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
