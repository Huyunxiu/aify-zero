# 启动时应用迁移

迁移文件是表结构的唯一来源：`db:generate` 生成、启动 server 时应用，开发态和
打包后的应用走同一条路径。此前开发期靠 `drizzle-kit push` 直接改表，打包后靠
`Resources/migrations`，两条路径各自长出不同的库——push 建出来的库没有迁移
历史，打包应用一启动就报 `table already exists`，而这件事没有任何提示（用户目录里
的那个库当时只应用到 `0004`）。取舍是：开发期多一步 `db:generate`，换掉
「开发库和发布库结构来源不同」这个反复出现的故障。

理由：把「应用了什么」记在库里（`__drizzle_migrations`），而不是靠人记得跑哪条
命令。判断放在 `startServer` 内部而不是 npm script 里，任何入口启动 server 都
经过它，绕过 `vp dev` 直接跑入口也不会退回旧行为。迁移失败即中止启动：表结构
是前置条件，在结构漂移的库上提供服务只会把错误推到第一个请求里，变成难查的
`no such column`。空历史但已建表的库不自动基线，也不自动删库——自动基线等于把
「结构漂移」也标记成「已应用」，自动删库则会永久丢掉开发数据；这两种都由人显式
执行一次。

## Considered Options

- **开发期继续 `db:push`，只在打包后迁移（原状）**：开发期零成本，但两套机制
  并存，push 建出的库没有历史，而打包后的应用拒绝这种库。
- **在 `vp dev` 脚本里加一步迁移**：改动更小，但绕过这个脚本的入口
  （`tsx apps/server/src/index.ts`、桌面内置 server、独立打包的 server）会退回
  旧行为，判断散落在各个脚本里。
- **先 `migrate` 再 `push` 兜底**：掩盖「忘了 `db:generate`」，让结构漂移变成
  常态。
- **迁移失败只告警、继续启动**：服务跑在结构漂移的库上，错误推迟到第一个请求。
- **自动基线**：看起来省事，但会把任何「历史为空」的库都标记为最新，包括真正
  需要迁移的那些。
- **迁移文件即唯一来源（选中）**：开发期多一条命令，换来一个机制、启动即一致、
  失败可见。

## Consequences

- 改 `src/schema` 必须跟一条迁移；`vp ready` 里的 `db:check` 会在副本目录里试
  生成一次，能生成新迁移就判定为结构漂移。
- 迁移目录是本模块附近带 `meta/_journal.json` 的 `migrations/`（向上找四层）：
  源码态命中 `packages/db/src/migrations`；`apps/server` 的构建产物由
  `scripts/stage-server-dist.ts` 复制到 `dist/migrations`，而打包器把模块放进
  `dist/assets/`，所以要向上找一层。Electron 把 server 入口打包进
  `.vite/build`，那里没有迁移文件，所以主进程无条件传 `AIFY_MIGRATIONS_DIR`。
- 开发库固定在 checkout 根部：worktree 不带被 gitignore 的 `local.db`，缺文件时
  不会再回落到 `~/.aify-zero` 和其他 worktree 共用；打包后仍然是
  `~/.aify-zero/aify-zero.db`。
- 旧库要人工处理一次：空历史建表的库跑 `db:baseline`，迁移历史少几条的库正常向前迁移。
  `db:baseline` 先把迁移重放到临时库比对结构，只有结构一致才写入历史——基线是承认
  这个库就是迁移的产物，不是跳过检查。
- 两个进程同时打开同一个库时，先到的那次迁移会让另一个报 `SQLITE_BUSY`；错误
  信息直接点明「另一个进程正在迁移」，不做重试。
- `db:push` 与 `db:local` 已删除。恢复 `db:push` 会让空历史库重新出现，等于把
  这个决定作废。
- CLI 的默认库是 checkout 根部的 `local.db`，运行期的默认库是
  `~/.aify-zero/aify-zero.db`：前者服务开发流程，后者服务打包后的用户。
