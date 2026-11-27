# Agent

The Assistant of one session: the model loop. A session holds turns. A turn holds steps. One run
drives one assistant turn. Tools, hooks, and instructions sections enter this loop at assembly.

## Language

**Assistant (助理)**:
The agent one session talks to: the model loop, with the tools, skills, subagents, and timers it
can use. The code calls it `Agent`, and the table calls it `agents`; the user-facing word is
Assistant. The word also names the role of one turn — an assistant turn holds the answer — and
that turn is not the Assistant.
_Avoid_: 助手、智能体、机器人、bot

**Subagent (子代理)**:
An Assistant that one session starts to carry one brief. It has its own session and transcript,
its own tools, and the approval policy the delegating session held when it started. It cannot
start another subagent, and it cannot ask the user anything. It reports to the Assistant that
started it, and that Assistant can message it again after it reports.
_Avoid_: 子 agent、子代理进程、worker、后台代理

**Subagent Name (子代理名)**:
The handle one session uses to reach one of its subagents. It is unique among that session's
subagents, and it does not change. Two sessions can each hold a subagent of the same name.
_Avoid_: id、句柄、别名

**Turn (回合)**:
One exchange between the user and the model, in the order of a session. A user turn holds
one input. An assistant turn holds the answer to it. One run can make many user turns and
one assistant turn.
_Avoid_: 轮、对话轮、用户回合

**Transcript (会话记录)**:
All the turns that settled in order in one session. The transcript of a subagent is the
transcript of its own session. Pending approvals live in it. Compaction appends markers and
summaries to it, and the text of a covered turn stays there: compaction changes the
model-side history, not the transcript.
_Avoid_: 转录、对话记录、历史

**Run (运行)**:
One model execution from start to end, identified by a run id. At its start, the run claims
every inbox item, makes each item a user turn, and then drives the assistant turn that
follows the last one. The event stream, the claim, and a pause all have the run as their
boundary.
_Avoid_: 任务、会话、流

**Inbox (收件箱)**:
The things in a session that arrived in order and did not enter the loop. User messages,
timer firings, and external events write here. A run claims from it at its start.
_Avoid_: 待发箱、发送队列

**Inbox Item (待办项)**:
One row in the inbox. It holds the content, the arrival order, and the earliest boundary
where the item can enter: in the middle of the current run, or at the next run. A run can
claim many items. Each item is still a separate user turn. Only one reply exists, and it
follows the last turn.
_Avoid_: 消息、事件、任务、合并

**Outbox (发件箱)**:
The reply records of a session that settled and did not reach a person. It is the opposite
of the inbox: the inbox holds what comes in, and the outbox holds what goes out. A run
leaves one record when it settles as `done` and it did speak. A run leaves no record when
it has nothing to say, fails, is canceled, or waits for approval.
_Avoid_: 发送队列、通知列表

**Outbox Item (发件项)**:
One row in the outbox. It points at a settled turn. It does not store the body: the body is
in the steps of the turn, and a copy of it would diverge on compaction and regeneration. It
stays for the record after delivery. An item that did not deliver stays for the record
after it expires.
_Avoid_: 消息、通知、提醒、推送

**Delivery (投递)**:
Delivery turns one outbox item into one system notification. It counts when the notification
shows, not when the user sees it. Delivery is not a handoff: a handoff puts an inbox item
into the model loop (inbound), and delivery sends an outbox item to a person (outbound).
_Avoid_: 发送、推送、通知

**Delivery Dispatcher (投递器)**:
The scan loop in the process. It picks the outbox items that meet the condition, pushes
them to the desktop connection that waits, and collects the receipt. It does not show a
notification. It does not decide if the user saw it. A row that it pushed does not go out a
second time.
_Avoid_: 调度器、发送器、worker

**Job (后台任务)**:
A command or a unit of work that the model starts and that lives longer than one request. A
registry records its identity, owner, lifecycle, and output. The producer owns the execution
resource. In prose, "task" is a short form of it, but "task" must not name a run.
_Avoid_: 作业、job（中文行文）、后台进程

**Completion Notice (完成通知)**:
One message that a background unit of work sends to its owner after it settles. The producer
is a job or a subagent. It is not user input. It does not end a run.
_Avoid_: 完成消息、回调、完成事件

**Timer (定时器)**:
An object on a session that has a next fire time. At that time, it writes one inbox item,
and the session can wake for that item. A timer does not run the model itself, and it does
not belong to one run. Two kinds: Follow-up and Schedule.
_Avoid_: 提醒、闹钟、定时任务、cron

**Follow-up (跟进)**:
A timer that fires one time. After it fires, it no longer exists. The run at that time uses
the model that was set when the follow-up was made.
_Avoid_: 提醒、一次性任务、超时

**Schedule (日程)**:
A timer that repeats on a cycle. After it fires, it moves the due time to the next one,
until someone cancels it. It holds one recurrence rule. A calendar rule also holds a time
zone, fixed when the schedule is written.
_Avoid_: 定时任务、周期任务、循环任务、cron

**Recurrence Rule (周期规则)**:
The rhythm of a schedule: every day, some days of the week, or a fixed interval. The first
two count local wall-clock time. The third counts absolute milliseconds.
_Avoid_: cron 表达式、RRULE、重复规则

**Steering (插话)**:
One sentence that a person or another agent adds during a run. It enters the current turn as
a steering message at the next step boundary. It does not become a separate user turn.
_Avoid_: steer、中途消息

**Session Event Stream (会话事件流)**:
The event channel of a session. It joins successive runs into one sequence for the reader.
Each run is its own segment (`run.start` to `run.end`), and the gaps between runs do not
close it. The reader reads forward from the session cursor, so the reader already watches
when a queued inbox item is claimed.
_Avoid_: 数据流、事件流（一次运行的）

**Tool (工具)**:
One action that the model can request. A name, a description, and an input structure
describe it. Built-in tools and MCP tools are both tools; only their source is different.
_Avoid_: 函数、函数调用、能力

**MCP Server (MCP 服务器)**:
One separate process or HTTP service that supplies tools over the MCP protocol.
_Avoid_: 插件、集成、连接器、外部服务

**MCP Tool (MCP 工具)**:
One tool that belongs to an MCP server. It has the same rank as a built-in tool in a
session, but its availability depends on whether that server connects.
_Avoid_: 远程工具、外部工具、第三方工具

**Exposure (暴露方式)**:
The choice to declare a tool to the model with each step request, or to keep it in the tool
catalog until the model searches for it.
_Avoid_: 可见性、模式、mode、懒加载

**Tool Catalog (工具目录)**:
The set of tools that the model cannot see now but can find by search. It is not a new
source. It is only the hidden part of the tools.
_Avoid_: 注册表、索引、工具箱

**Route (转调)**:
The model gives the exact tool name and input. The kernel finds that tool and runs it. The
model does not call the tool directly.
_Avoid_: 代理、包装、网关、gateway

**Authorization (授权)**:
The process where the client gets the access credential of an MCP server after the user
agrees on that server. The user starts this process. The client does not agree on behalf of
the user.
_Avoid_: 鉴权、登录、认证

**Authorization Token (授权令牌)**:
The credential that the client holds after authorization and sends to the MCP server with
each request. It is not the access token of the local API. The first belongs to a
third-party server. The second only proves that the request comes from the local client.
_Avoid_: 密钥、apiKey

**Extension (扩展)**:
One piece of code that registers tools, hooks, or instructions sections at session assembly. An
extension can register more than one tool. An MCP server is not an extension.
_Avoid_: 插件、模块、集成

**System Prompt (系统提示)**:
The text a session sends as the model's instructions with every step request. It starts with an
identity: the main session reads `MAIN_INSTRUCTIONS`, and a subagent reads its own preamble. Each
instructions section then contributes its block, in priority order. Nothing else writes it: a start patch
changes the call, not the prompt. The code names this field `instructions`.
_Avoid_: 提示词、提示片段、系统消息、system message

**Instructions Section (指令段)**:
One block of system prompt text that an extension contributes at assembly. It holds an id, a
priority, and a render function; a lower number renders earlier. The function returns the
section's own block and nothing else: the writer joins the blocks, so no section writes a
separator. A section belongs to the extension that registers it. It gives a subagent different
text through `renderForSubagent` when what it says does not hold for a subagent, and an empty
block means the subagent does not read it at all.
_Avoid_: 提示片段、prompt fragment

**Skill (技能)**:
A set of instructions stored as a `SKILL.md` file in a skill directory, which one session loads on
demand with the `load-skill` tool. The system prompt lists the available skills with their
descriptions; the body enters the conversation only when the model loads it.
_Avoid_: 提示模板、prompt template、插件

**Retry (重试)**:
One new request with the same history in the same turn, after a step fails. A retry is a
step itself. The count applies to retries only. The first request does not count, and each
new request after it counts as one retry.
_Avoid_: 重发、再试、重新生成、尝试

**Runner (运行器)**:
The resident driver of one session. It claims inbox items, starts a run, and pauses after a
failure or an abort. It holds the only run lock. It runs create / resume / stop / compact /
fork for the session. Only the runner starts a run of the main session.
_Avoid_: 调度器、worker、后台服务、运行时

**Paused (暂停)**:
The state where the runner does not start the next run automatically. A pause is a brake on
automatic progress. It does not close the session.
_Avoid_: 停止、中断、挂起

**Approval Policy (审批策略)**:
The asking stance of one session on tool calls: which calls the session passes, which calls
it must ask about, and which calls it does not permit. The policy decides only if the
session asks; the sandbox decides if the call can occur. The policy that the user selects
lives on the session, and every run applies it as it is.
_Avoid_: 权限模式、permissionMode、授权、策略模式

**Approval Class (审批类别)**:
The approval category of one tool: read, mutate, exec, interact, or unknown. The policy
answers by class, not by tool name. The class of an MCP tool comes from the annotation of
its server. If that annotation is absent, the class is unknown.
_Avoid_: 风险等级、权限级别、工具类型

**Attachment (附件)**:
The bytes one read recorded. A transcript replays its reads, so an attachment never changes:
the digest of its bytes identifies it, not a name. It is not an Asset: an asset is a mutable
file an owner replaces by name.
_Avoid_: 资源、上传、文件、blob

**Content (内容)**:
What a read answers with, in one of three forms: the text of a file, the entries of a
directory, or an attachment. The path decides the form; the model does not choose it.
_Avoid_: 正文、数据、结果

**Input Kind (输入种类)**:
One media kind a model route declares it accepts, as the settings schema spells it: text,
image, audio, video, or pdf. A model route that declares nothing accepts text only, so an
unknown model route never receives an image.
_Avoid_: 模态、能力、modality

**Normalized Copy (规范化副本)**:
The stored form of an image attachment: one frame, 8-bit, sRGB, no metadata, inside fixed
pixel and byte budgets. It is what a read stores; the source file stays where it was, and the
reference records the original dimensions so a reader can map coordinates back.
_Avoid_: 缩略图、缓存图、派生图

**Model Route (模型路线)**:
One model call's destination, in the two facts request assembly needs: the protocol the
provider accepts, and the media kinds the model reads. It is read once per step, because a
patch can move the session to another model. It is not a `Route`: the route of this file
redirects a tool call.
_Avoid_: 模型配置、供应商、通道

**Region (区域)**:
The part of an image one read keeps, given as four fractions of its width and height. A read
without a region keeps the whole image; a read with one works at source resolution inside it.
_Avoid_: 裁剪框、crop、视口

**Crop Box (裁剪框)**:
The same region as `Region`, in source pixels: where the box starts and how large it is after
orientation. A region is what a caller asks for; a crop box is what the read did.
_Avoid_: 矩形、rect、bounding box
