# Issue 跟踪：Linear

> 本文件是 [`issue-tracker.md`](./issue-tracker.md) 的中文镜像。改动要同时改两份。

本仓库的 issue 和规格都存放在 Linear。工作区 `Aify0`（https://linear.app/aify0），团队 `AIFY0`，
编号格式为 `AIFY0-<n>`。所有操作使用 Linear MCP 工具（`mcp__linear__*`）。不要对本仓库使用 `gh issue`。

## 约定

- **新建 issue**：`save_issue`，传 `team: "AIFY0"`。可以马上开工就传 `state: "Todo"`，还不能开工就传
  `"Backlog"`。除用户点名别人，否则传 `assignee: "me"`。只有用户点名项目时才传 `project: "Aify Zero"`。
- **标题语言**：按请求的语言写标题。这个团队的标题中英文都有。
- **读取 issue**：`get_issue`，参数为 `AIFY0-<n>`。需要看阻塞关系时加 `includeRelations: true`。
- **列出 issue**：`list_issues`，传 `team: "AIFY0"`，再加 `state`、`label`、`assignee`、`project`、
  `parentId` 或 `query`。结果是分页的：`hasNextPage` 为 true 时，用 `cursor` 继续取下一页。
- **评论**：`list_comments` 读讨论。`save_comment` 传 `issueId` 发顶层评论。传 `parentId` 是回复某条评论。
- **标签**：增删一两个标签用 `addLabels` 和 `removeLabels`。`labels` 会替换整个标签集合。
- **关闭**：先用 `save_comment` 写说明，再用 `save_issue` 把 `state` 设为 `"Done"`。判定为不修时，
  把 `state` 设为 `"Canceled"`，不贴标签（见 `docs/agents/triage-labels.md`）。
- **关联 PR、commit 或规格**：`save_issue` 传 `links: [{url, title}]`。链接只增不减。
- **阻塞关系**：`save_issue` 传 `blockedBy`、`blocks`、`relatedTo`。这三种关系只增不减。解除关系用
  `removeBlockedBy`、`removeBlocks`、`removeRelatedTo`。所有阻塞项进入 `Done` 或 `Canceled` 后，这张票才能开工。
- **上传附件**：先 `prepare_attachment_upload`，再 PUT 文件字节，然后 `create_attachment_from_upload`。
  要在 Markdown 里嵌图片，用 `prepare_file_upload`，把返回的 Markdown 插入正文。

## 状态

`Backlog` → `Todo` → `In Progress` → `In Review` → `Done`。`Canceled` 表示不修。`Duplicate` 表示重复。

## 标签

团队标签：`Bug`、`Feature`、`Improvement`，以及 `docs/agents/triage-labels.md` 里的分诊标签。

## 范围

只往工作区 `Aify0` 的团队 `AIFY0` 提 issue。不要写到其他团队或工作区。

## 当技能说「发布到 issue 跟踪器」

在团队 `AIFY0` 新建一个 Linear issue。

## 当技能说「读取相关票」

按上面 **读取 issue** 的做法读。同时读它的评论。

## Wayfinder 操作

供 `/wayfinder` 使用。**地图**是一张带 `wayfinder:map` 标签的 issue。它的**票**是把 `parentId` 指向地图的
子 issue。

- **地图**：`save_issue`，传 `team: "AIFY0"` 和 `labels: ["wayfinder:map"]`。首次使用时用 `save_issue_label`
  创建这个标签。
- **子票**：`save_issue`，传 `parentId: "AIFY0-<map>"` 和 `labels: ["wayfinder:<type>"]`，其中 `<type>` 是
  `research`、`prototype`、`grilling` 或 `task`。首次使用时创建标签。
- **阻塞**：在子票上写 `blockedBy`（见上面 **阻塞关系**）。
- **边界查询**：`list_issues`，传 `team: "AIFY0"`、`parentId: "AIFY0-<map>"`、`state: "Todo"`、
  `assignee: "null"`。去掉还有未关闭阻塞项的票（用 `get_issue` 加 `includeRelations: true` 查）。
  地图顺序里的第一张票优先。
- **认领**：`save_issue`，传 `assignee: "me"`。这是本次会话的第一次写操作。
- **结票**：`save_comment` 写答案，`save_issue` 把 `state` 设为 `"Done"`，然后往地图的「已定决策」追加一行。
