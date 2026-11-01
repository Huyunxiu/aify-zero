import type {
  Client,
  InArgs,
  InStatement,
  ResultSet,
  Transaction,
  TransactionMode,
} from "@libsql/client";

/**
 * 一把先进先出的互斥锁。
 *
 * 等锁而不是失败：本地 SQLite 的 `busy_timeout` 默认是 0，争用会立刻变成
 * `SQLITE_BUSY`，而这里的调用者只是要写同一行数据，等一下就好。
 */
class Mutex {
  #tail: Promise<void> = Promise.resolve();

  /** 取锁；返回释放函数。 */
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => held);

    await previous;
    return release;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await work();
    } finally {
      release();
    }
  }
}

/**
 * 让一个 libsql 客户端一次只跑一条语句。
 *
 * libsql 的 `transaction()` 会把当前连接交给事务，并为之后到达的查询**另开
 * 一条连接**。两条连接同时写同一个文件时，SQLite 立刻返回
 * `SQLITE_BUSY: database is locked`——本地库的 `busy_timeout` 默认是 0，不会等。
 * 这个进程里同时有流式写 step、UI 轮询、子会话注册，撞上事务的窗口很常见。
 *
 * 排队之后，事务从 BEGIN 到 COMMIT 期间独占客户端，其他语句按到达顺序排在后
 * 面；进程内因此不再有二条写连接。跨进程争用不在这个范围内：同一个库文件
 * 只应该有一个服务端进程持有。
 */
export function serializeClient(client: Client): Client {
  const mutex = new Mutex();

  const execute = (
    statement: InStatement | string,
    args?: InArgs
  ): Promise<ResultSet> =>
    mutex.run(() =>
      typeof statement === "string"
        ? client.execute(statement, args)
        : client.execute(statement)
    );
  const batch: Client["batch"] = (statements, mode) =>
    mutex.run(() => client.batch(statements, mode));
  const executeMultiple: Client["executeMultiple"] = (sql) =>
    mutex.run(() => client.executeMultiple(sql));
  const migrate: Client["migrate"] = (statements) =>
    mutex.run(() => client.migrate(statements));

  return new Proxy(client, {
    get(target, property, receiver) {
      switch (property) {
        case "execute": {
          return execute;
        }
        case "batch": {
          return batch;
        }
        case "executeMultiple": {
          return executeMultiple;
        }
        case "migrate": {
          return migrate;
        }
        case "transaction": {
          return (mode?: TransactionMode) =>
            openTransaction(target, mutex, mode);
        }
        default: {
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        }
      }
    },
  });
}

/**
 * 开一个事务，并在它结束时放锁。
 *
 * drizzle 在 `commit()` 或 `rollback()` 之后不再调用 `close()`（见
 * drizzle-orm/libsql 的 session），而 libsql 的 `close()` 只回滚、不关连接。
 * 这里两件事都做：先确保事务内的锁被释放，再放行排队的语句；`commit()` 自身
 * 抛错时也一样，否则一条卡住的事务会让整个进程再也写不进去。
 */
async function openTransaction(
  client: Client,
  mutex: Mutex,
  mode?: TransactionMode
): Promise<Transaction> {
  const release = await mutex.acquire();

  let inner: Transaction;
  try {
    inner = await client.transaction(mode);
  } catch (error) {
    release();
    throw error;
  }

  let released = false;
  const finish = (): void => {
    if (released) {
      return;
    }
    released = true;
    try {
      // 事务仍在进行时回滚，别把连接和它的锁留给下一条语句。
      inner.close();
    } finally {
      release();
    }
  };

  return new Proxy(inner, {
    get(target, property, receiver) {
      switch (property) {
        case "commit":
        case "rollback":
        case "close": {
          const end = Reflect.get(target, property, target) as (
            ...args: unknown[]
          ) => Promise<void> | void;
          return async (...args: unknown[]) => {
            try {
              return await end.apply(target, args);
            } finally {
              finish();
            }
          };
        }
        default: {
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        }
      }
    },
  });
}
