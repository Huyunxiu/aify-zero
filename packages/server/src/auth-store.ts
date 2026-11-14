/**
 * 登录态与登录票据的存储。
 *
 * 两张表都只存令牌的 SHA-256：数据库文件被读走，也换不来一次登录。令牌
 * 只出现在响应、cookie 和打印出来的链接里。
 *
 * 时间统一走注入的 `now`，测试用它把登录态放到过期之后，不必真的等待。
 */
import { createHash, randomBytes } from "node:crypto";

import {
  auth_login_ticket_table,
  auth_session_table,
  auth_user_table,
  db,
} from "@workspace/db";
import {
  AUTH_SESSION_REFRESH_MS,
  AUTH_SESSION_TTL_MS,
} from "@workspace/shared/auth-session";
import { eq, lt } from "drizzle-orm";

/** 单操作者的固定 id：重复调用 {@link AuthStore.ensureOperator} 只落一行。 */
const OPERATOR_ID = "operator";

const OPERATOR_NAME = "Operator";

const TOKEN_BYTES = 32;

/**
 * 本次进程运行的标识。
 *
 * 登录票据绑定在它上面：重启会换一个新值，旧链接因此失效；同一次运行里票据
 * 可以反复用。放在模块级，同一个进程里的所有存储实例共用一个值。
 */
const PROCESS_INSTANCE = randomBytes(TOKEN_BYTES).toString("base64url");

/** 一次登录态校验的结果。 */
export interface AuthSessionRecord {
  readonly userId: string;
}

/** 登录态与票据的读写接口；测试可注入替身。 */
export interface AuthStore {
  /**
   * 取到操作者，没有就建一个。
   *
   * @returns 操作者 id。
   */
  ensureOperator(): Promise<string>;
  /**
   * 新建一条登录态。
   *
   * @param userId - 操作者 id。
   * @returns 明文令牌和到期时间；令牌不落库。
   */
  createSession(userId: string): Promise<{ token: string; expiresAt: Date }>;
  /**
   * 校验令牌；过期返回 undefined，用久了顺手续期。
   *
   * @param token - cookie 里的明文令牌。
   */
  findSession(token: string): Promise<AuthSessionRecord | undefined>;
  /**
   * 删除一条登录态。
   *
   * @param token - cookie 里的明文令牌。
   */
  deleteSession(token: string): Promise<void>;
  /**
   * 签发一条登录票据。
   *
   * 票据不按时间过期：只在签发它的进程退出后失效。
   *
   * @param userId - 操作者 id。
   */
  createLoginTicket(userId: string): Promise<{ token: string }>;
  /**
   * 按票据找到操作者。
   *
   * @param token - 链接里的明文票据。
   * @returns 票据属于本次进程运行时为操作者 id，否则为 undefined。
   */
  findLoginTicket(token: string): Promise<string | undefined>;
  /** 清掉已经过期的登录态。 */
  pruneExpired(): Promise<void>;
}

export interface AuthStoreOptions {
  /** 当前时间；测试注入固定时钟。 */
  readonly now?: () => Date;
  /** 进程运行标识；测试用它模拟“上一次运行”。 */
  readonly instance?: string;
}

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const createToken = (): string =>
  randomBytes(TOKEN_BYTES).toString("base64url");

/**
 * 建一个走全局数据库连接的存储。
 *
 * 表在 `@workspace/db` 的迁移里；没有跑迁移时这里会报“表不存在”，启动
 * 路径会把这条错误降级成一条警告。
 *
 * @param options - 时钟注入。
 */
export function createAuthStore({
  now = () => new Date(),
  instance = PROCESS_INSTANCE,
}: AuthStoreOptions = {}): AuthStore {
  return {
    async ensureOperator() {
      const existing = await db
        .select({ id: auth_user_table.id })
        .from(auth_user_table)
        .limit(1);

      if (existing[0] !== undefined) {
        return existing[0].id;
      }

      await db
        .insert(auth_user_table)
        .values({ id: OPERATOR_ID, name: OPERATOR_NAME })
        .onConflictDoNothing();

      return OPERATOR_ID;
    },

    async createSession(userId) {
      const token = createToken();
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + AUTH_SESSION_TTL_MS);

      await db.insert(auth_session_table).values({
        id: hashToken(token),
        userId,
        createdAt,
        lastUsedAt: createdAt,
        expiresAt,
      });

      return { token, expiresAt };
    },

    async findSession(token) {
      const id = hashToken(token);
      const rows = await db
        .select()
        .from(auth_session_table)
        .where(eq(auth_session_table.id, id))
        .limit(1);
      const [row] = rows;

      if (row === undefined) {
        return;
      }

      const current = now();

      // 过期的行留在这里只会让下一次校验再做一次判断；顺手删掉。
      if (row.expiresAt.getTime() <= current.getTime()) {
        await db
          .delete(auth_session_table)
          .where(eq(auth_session_table.id, id));

        return;
      }

      if (
        current.getTime() - row.lastUsedAt.getTime() >=
        AUTH_SESSION_REFRESH_MS
      ) {
        const expiresAt = new Date(current.getTime() + AUTH_SESSION_TTL_MS);

        await db
          .update(auth_session_table)
          .set({ expiresAt, lastUsedAt: current })
          .where(eq(auth_session_table.id, id));
      }

      return { userId: row.userId };
    },

    async deleteSession(token) {
      await db
        .delete(auth_session_table)
        .where(eq(auth_session_table.id, hashToken(token)));
    },

    async createLoginTicket(userId) {
      const token = createToken();

      await db.insert(auth_login_ticket_table).values({
        id: hashToken(token),
        instance,
        userId,
      });

      return { token };
    },

    async findLoginTicket(token) {
      const rows = await db
        .select({
          instance: auth_login_ticket_table.instance,
          userId: auth_login_ticket_table.userId,
        })
        .from(auth_login_ticket_table)
        .where(eq(auth_login_ticket_table.id, hashToken(token)))
        .limit(1);
      const [row] = rows;

      // instance 对不上就是上一次运行留下的链接，和不存在没有区别。
      return row === undefined || row.instance !== instance
        ? undefined
        : row.userId;
    },

    async pruneExpired() {
      await db
        .delete(auth_session_table)
        .where(lt(auth_session_table.expiresAt, now()));
    },
  };
}
