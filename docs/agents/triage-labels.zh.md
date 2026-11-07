# 分诊标签

> 本文件是 [`triage-labels.md`](./triage-labels.md) 的中文镜像。改动要同时改两份。

技能用五个标准分诊角色说话。本文件把这些角色映射到本仓库 Linear 团队 `AIFY0` 实际使用的标签。

| 技能里的标签名    | 本仓库的写法                      | 含义                          |
| ----------------- | --------------------------------- | ----------------------------- |
| `needs-triage`    | `needs-triage`                    | 维护者需要评估这张票          |
| `needs-info`      | `needs-info`                      | 等报告人补充信息              |
| `ready-for-agent` | `ready-for-agent`                 | 已写清，可交给 agent 自主完成 |
| `ready-for-human` | `ready-for-human`                 | 需要人来实现                  |
| `wontfix`         | 无标签，用 Linear 状态 `Canceled` | 不做                          |

前四个标签属于团队 `AIFY0`。技能要贴分诊标签时，用 `addLabels`。
技能要把角色解析为 `wontfix` 时，把 issue 的状态改成 `Canceled`，不要贴标签。
