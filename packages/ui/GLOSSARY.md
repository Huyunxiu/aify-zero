# UI

The session panel and its views: files, changes, terminal, and a subagent's record. It
draws the external state a session can reach — workspace files and git changes — as areas
a reader can click and read.

## Language

**Review View**:
A view in the session panel. It lists the changes on the right and draws the content
diff of the selected change on the left.
_Avoid_: Changes page, diff panel

**Change**:
A file path in the workspace that differs from the baseline. One path is one change,
whatever the number of times it changed.
_Avoid_: Changed item, diff, patch

**Baseline**:
The reference that answers "what changed". It is the `HEAD` of the repository. When the
repository has no first commit, the baseline is the empty tree.
_Avoid_: Target version, original version

**Untracked File**:
A file that git does not record. It is one whole addition against the baseline.
_Avoid_: New file, not under version control

**Change Status**:
The nature of one change against the baseline: added, modified, deleted, renamed,
untracked.
_Avoid_: Difference kind, change kind

**Pure Rename**:
A change whose path changed and whose content did not. The review view draws the whole
content as an addition on its left side.
_Avoid_: Empty change, path-only change

**Icon Key**:
A name that points to one brand image. A key with the `-color` suffix points to the
colored image; every other key points to the monochrome image.
_Avoid_: Logo name, icon id

**Provider Icon**:
The brand image of the provider side, taken from the identity of the provider.
_Avoid_: Brand avatar, provider logo

**Model Maker**:
The side that made a model. It is a property of the model, and it is not the same
identity as the provider that serves the calls.
_Avoid_: Model vendor, model author, vendor

**Model Icon**:
The brand image of the model maker, independent of the model version: two versions from
one maker draw the same image.
_Avoid_: Model avatar, model logo

**Step**:
One segment of a turn: a piece of content that the model wrote, or one tool call. Every
row in the chain is a step.
_Avoid_: Link in the chain, node

**Step View**:
The way one step is drawn in the chain: what the row says, and what a click shows. Its
unit is the kind of part, not the tool name — one view can serve several tools.
_Avoid_: Tool component, tool panel, renderer

**Subagent View**:
A view in the session panel. It draws the transcript of a subagent that one `task` call of
this session started. It takes no input: the turns of a subagent belong to the call that
made it, and nothing outside that call can answer a call it was held on.
_Avoid_: Subagent page, subagent pane, mini transcript

**Block**:
One segment of the interface, made of components, that owns the code computing its own
content. A sidebar, one settings section, and the view of one step are blocks.
_Avoid_: element, element component, widget

## Where a session lives

**Session Host**:
The session instance that holds state on screen. The shell holds it; a change of address
does not change it.
_Avoid_: Session page, keep-alive

**Covered**:
The session still runs and still reads its event stream, but another route covers it and
the reader cannot see it.
_Avoid_: Hidden, paused, in the background

**Session Outline**:
The table of contents on the left of the session transcript. Each entry matches one
question from the reader and holds the replies after that question and before the next
one. A click on an entry moves the transcript to that question.
_Avoid_: Minimap, timeline, directory tree

**Question**:
One user turn that the reader wrote. Completion notices and timers also arrive as user
turns, but they are not questions and do not become entries of the session outline.
_Avoid_: Message, prompt, input

**Settings Section**:
One partition of settings on an address. One section is one route, and it opens on its
own.
_Avoid_: Settings page, settings tab, tab
