# End-to-end tests

Read this page when you must prove that the whole stack still connects. Each case gets its
own scene: one browser and one real API process. The case tears the scene down when it ends.

The page covers the seams, not the logic:

| Seam                                   | How a case reaches it                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Browser ↔ local API                    | The case exchanges the login link that the server prints for a cookie. The page sends its own requests.                      |
| HTTP ↔ runner                          | The case sends one message. It waits until the runner completes the turn.                                                    |
| Runner ↔ sandbox                       | The model asks for one `edit-file`. The tool writes to the disk.                                                             |
| Disk ↔ review view                     | The session panel compares against the baseline. It lists the file that changed.                                             |
| Job registry ↔ inbox                   | A background command settles and writes one completion notice. The idle session then wakes up.                               |
| Timer ↔ inbox                          | A timer comes due and writes one inbox item. The idle session then wakes up.                                                 |
| Schedule ↔ inbox and store             | A schedule comes due and writes one inbox item. That row advances. It does not delete.                                       |
| Notice ↔ transcript                    | The turn appears in the transcript as a notice block, not as a user bubble.                                                  |
| Outbox ↔ app channel                   | The case subscribes to the channel. After the run settles, the notice arrives. After the receipt, the state returns to zero. |
| Approval policy ↔ runner and interface | The policy that the session stores goes into the run. That policy decides if the card appears.                               |

The [fake provider](fake-provider.md) answers for the model side. It replaces the provider,
so these cases use no network, spend no money, and give the same result each time.

## Run

```bash
vp run e2e
```

A short case takes about 8 seconds; the range is 2.7 to 13.9 seconds. The suite takes
about 4.5 minutes on macOS arm64: 16 cases in 13 files. Three cases wait tens of seconds
each, and they carry most of that time: `approval-policy` (Unattended) 66 seconds,
`schedule` 35 seconds, `timer` 66 seconds.

The suite needs a Chromium browser. On macOS, one command installs it, and the system
libraries come with the operating system:

```bash
vp exec playwright install chromium
```

The browser lands in `~/Library/Caches/ms-playwright`. `--with-deps` does nothing on
darwin: `playwright-core` reads that flag on win32 and linux only.

On Linux with root, one command installs the browser and its system libraries:

```bash
vp exec playwright install --with-deps chromium
```

On Linux x86_64 without root, put the browser and the libraries inside the repository,
then point two variables at them:

```bash
PLAYWRIGHT_BROWSERS_PATH=$PWD/.e2e/browsers \
LD_LIBRARY_PATH=$PWD/.e2e/sysroot/usr/lib/x86_64-linux-gnu \
vp run e2e
```

To fill those two directories: install the browser with
`PLAYWRIGHT_BROWSERS_PATH=$PWD/.e2e/browsers vp exec playwright install chromium`,
then `apt-get download` the missing packages and unpack each one into `.e2e/sysroot`
with `dpkg-deb -x`. Both directories sit under `.e2e/`, so neither enters the
repository. The packages are x86_64 Linux binaries, so another architecture needs its
own set.

### Run one case

Pass the file path to Playwright:

```bash
vp exec playwright test --config e2e/playwright.config.ts e2e/outbox.e2e.ts
```

`vp run e2e -- e2e/outbox.e2e.ts` prints no error and runs the whole suite: `vp run`
passes `--` and the path through, and Playwright does not read the path as a filter.

### The browser is installed elsewhere

On Linux x86_64, point `PLAYWRIGHT_BROWSERS_PATH` at that installation, and
`LD_LIBRARY_PATH` at the `usr/lib/x86_64-linux-gnu` directory that holds the unpacked
system libraries:

```bash
PLAYWRIGHT_BROWSERS_PATH=<browser directory> \
LD_LIBRARY_PATH=<libraries directory>/usr/lib/x86_64-linux-gnu \
vp run e2e
```

On macOS, `PLAYWRIGHT_BROWSERS_PATH` is the only variable: the system provides the
libraries that Chromium loads.

In a worktree, note one thing: the harness reads the repository root as the worktree
itself, so `.e2e/` belongs to the worktree too. You can install the browser once and point
`PLAYWRIGHT_BROWSERS_PATH` at the copy in the main checkout.

The browser locale is fixed to `en-US`. The application uses the i18n default for its own
language, because each case gets a new context and its `localStorage` is empty.

## What the cases do

### Main flow (`journey.e2e.ts`)

1. Open `/?token=…`. The sidebar appears. The project group shows `No projects`.
2. Create a project. Point the main directory at a temporary Git repository.
3. Hover the project row. Create a session in the project.
4. Type one message and send it.
5. The user message appears in the transcript.
6. A tool step appears (the line that starts with `Edit`).
7. The turn title becomes `Finished`. The answer text sits below it.
8. Click the entry at the top right. The session panel opens on the right. Select `Changes`.
9. The review view says `1 files changed`. The tree holds `notes.md`. Click it. The changed
   line appears on the right.

The sidebar state takes no part in the assertions: after a turn, it returns to `Idle`, not
`Done`. The only final state is the `Finished` in the page.

The request sequence is also an assertion: exactly 1 non-streaming title request and 2
streaming body requests (first the tool, then the answer). The title request and the main
turn run concurrently, so the case counts the requests and does not fix their order.

### Approval policy (`approval-policy.e2e.ts`)

Three cases, and each one proves one seam: the policy persists, the run reads the policy, and
the interface asks only if the policy says so.

1. Edit policy: send one message that makes the model change a file. The tool really runs.
   The file lands on the disk. The turn completes. No approval card appears.
2. Read-only policy: the same scene. The tool is refused. The turn still completes. Not one
   character of the file changes. No approval card appears.
3. Timer: the session stores the edit policy, and no person attends the run that the timer
   starts. Nothing tightens the policy, so the change lands and no card appears: a run that
   nobody started uses the policy that the session stores.

The third case waits the 60-second timer minimum, and then waits for the scan loop to wake
the session. It sets its own budget of 180 seconds; the default in `playwright.config.ts`
is 120.

The behavior matrix (four policies × five classes, the fold of host rules and hooks) does not
live here. That part belongs to the table-driven cases in `packages/agent/tests`. A hook,
an MCP annotation, a subagent, a fork, and compaction cannot reach this scene. Here, they
would only become false evidence.

### Two queued messages get one answer from one run (`batching.e2e.ts`)

The user queues two messages during one run. The runner takes them together on the next
claim and gives one answer.

The case must first make a window in which the run is not over. Without a quiet window, the
first message starts at once. The two later messages share one claim only if the user
selects `queue` while the first run still runs. The scene therefore uses the script
`slow-answer`: the first chunk waits 3 seconds, which is enough time to type two messages.

The assertions have two layers. The interface shows three user messages, two `Finished`,
and an empty queue. The fake provider side shows two streaming requests. The interface
alone proves only that the user sees one reply. Only the request count proves that one
model loop ran.

### Completion notice (`job-notice.e2e.ts`)

The scene `job-notice` makes the model ask for one background command. The command is
`sleep 5`, and it prints `done`. The command lives longer than the first turn, so:

1. A `Bash` line appears. The background job really starts.
2. The first turn completes and is still `Finished`.
3. The job settles. The notice lands in the inbox. The idle session wakes up.
4. A notice block appears in the transcript. It has `role="note"` and the label
   `Background job finished`. Its header carries the command and the final state
   `[status: completed, exit code: 0]`. The body is the inline `done`.
5. The notice block has no buttons. It is not a user bubble, so it gives no copy and no
   regenerate.
6. The woken turn completes by itself. `Finished` becomes 2.

The case makes 3 streaming requests: the background command, the answer of the first turn,
and the answer of the woken turn. The non-streaming requests assert presence only: the
notice is itself a user turn, and the title generation asks once more for it. This case
does not prove if that request occurs.

### Timer (`timer.e2e.ts`)

The scene `timer` makes the model set a 60-second follow-up and then stop. The case really
waits a full minute:

1. The first turn completes. `Finished` is 1. The session returns to idle.
2. When the timer comes due, the scan loop turns the timer into one row in the inbox. The
   idle session wakes up.
3. A notice block appears in the transcript (`role="note"`, label `Timer fired`). The body
   carries the note that the model wrote at that time.
4. The notice block has no buttons. It is not a user bubble.
5. The woken turn completes by itself. `Finished` becomes 2.

The scan interval drops to 1 second in e2e (`AIFY_TIMER_SCAN_MS`). Without it, the case can
wait two full cycles at worst, which exceeds the case limit. The 60-second minimum of the
timer does not change: that minimum is the contract, and the case should really wait.

The case makes 3 streaming requests: the timer, the answer of the first turn, and the answer
of the woken turn.

### Schedule (`schedule.e2e.ts`)

The scene `schedule` computes its target at run time. `daily` writes a local "hour and
minute", so the case sets the target at the next whole minute, at least `LEAD_MS = 20_000`
after now, and the model sets a schedule from it. The wait measured about 35 seconds, and
the 300-second interval minimum need not change.

It uses the same chain as the timer case. Only the end differs:

1. The first turn completes. `Finished` is 1. The session returns to idle.
2. When the time comes, the notice block appears (its label is also `Timer fired`). The
   body can state the rule and `Next:`.
3. The case reads `pendingSchedules` back from `/api/openapi/timer/state`: **it is 1**. That
   row is still there, and only its due time advanced. This is the assertion that the
   follow-up case cannot give.
4. The woken turn completes by itself. `Finished` becomes 2.

Step 3 needs `Authorization: Bearer`: this read path needs credentials like the other
endpoints.

### Outbox (`outbox.e2e.ts`)

The scene `outbox` has one answer, and that answer needs no tool: at the end of the run, it
has something to tell the user. This case differs from the others because it does not open
the page:

1. The case acts as the connection of the desktop main process. It connects to `/api/ws`
   and sends `outbox.subscribe`.
2. It opens a session through the API and sends one message. The runner completes the turn.
3. Two seconds after the run settles, the notice arrives. The body takes the last text of
   that turn, and the title is the session title.
4. The case sends the receipt back.
5. `GET /api/openapi/outbox/state` says: no row waits for delivery, one push occurred, and
   a connection waits.
6. Three more scan cycles give no second batch. One row pushes once.

The case does not open the page on purpose. The page marks the session as read as soon as
it receives `run.end`, and "someone looked" is exactly the reason not to show a
notification. The case must prove the opposite, so it acts as the person who does not look.

The desktop process does not run inside Playwright, so the case does steps 1, 3, and 4
itself. It speaks the same protocol (`@workspace/shared/ws-protocol`). When the protocol
changes, the case and the desktop fail together.

### Hidden window (`outbox-hidden.e2e.ts`)

The desktop close-window action only calls `hide()`. The page stays, and it still receives
`run.end`. This case covers the half that `outbox.e2e.ts` misses when it does not look at
the page:

1. The page creates a project, opens a session, and sends one message. The scene is
   `slow-answer`, and the first chunk waits three seconds.
2. Before the run settles, the case sets the document to hidden. Chromium gives this state
   when Electron hides a window.
3. After the turn settles, the notice still arrives, and the session is still `done`.
4. When the page is visible again, the page marks the session as read. The session becomes
   `idle`.

If the page marks as read while hidden, the dispatcher thinks that a person looked, and the
system notification never appears. The read mark therefore depends on a visible page, not
on a page that exists.

### A Bot avatar is one stored asset (`bots-avatar.e2e.ts`)

The avatar is an uploaded image under the Bot's own `assets/` directory, and it travels
through one owner-generic byte route. Every face of that Bot draws the same bytes.

1. Open the settings from the sidebar row menu. Before the upload the page draws no image,
   so the initial of the name is the face.
2. Upload a 1×1 PNG. The settings header and the sidebar row show the image. The route
   checks the magic bytes, so a 1×1 file is enough.
3. Back in the session, three faces carry the image: the sidebar row, the session header,
   and the assistant message row.
4. Reload. The three faces stay, so the image was stored, not held in memory.
5. Remove the image. Every face falls back to the initial.

### One Bot's settings are addresses (`bots-settings.e2e.ts`)

Each settings section has its own address, so a reader can send someone a section and
reload it. The bare Bot address and `/settings` name no section, so each of them hands the
reader to the first section instead of drawing a section-less screen.

1. `Configure` opens `/bots/<id>/settings/general`. The run finishes behind the settings,
   so covering the session does not stop it.
2. `MCP servers` moves to `/settings/mcp` as a navigation, and `goBack` returns to
   `/settings/general`.
3. `Back to app` returns to the session address, not to the previous section.
4. The session keeps its draft and does not replay the turn: one `Finished`, and the draft
   is still in the composer.
5. The bare address and `/settings` replace themselves in the history, so `goBack` lands on
   the session.
6. A section address opens on its own and survives a reload.

### Deleting a session clears its row and its page (`session-delete.e2e.ts`)

1. Two sessions, each with one turn and its own title.
2. `Delete` in the row menu opens a dialog that names that session.
3. The list loses one row, the page falls back to the empty state (`Start a session`), and
   the other session stays.
4. Reload. The deleted session is still gone, so the server hides it and a cache does not.

### The sidebar orders sessions by the last activity (`session-order.e2e.ts`)

1. Session A runs one turn, and then session B runs one turn. B is newer on both the
   creation time and the last activity.
2. Return to A and run one more turn. A is older but more recently active, so it must move
   to the first row.
3. Both rows say `Just now`, and the case compares the vertical position of the two titles,
   so the assertion reads the order that the user sees.
4. The request count is the hard evidence here: 3 streaming answers for 3 turns, and 2
   non-streaming title requests for 2 sessions.

### Settings covers the session (`settings-keepalive.e2e.ts`)

Two cases. The first one opens settings while a run streams, with a draft typed and not
sent. Coming back must show the same session: one finished turn, no replay, and the draft
still in the composer. The second one starts from the session list, which has no session
id, and proves that the draft of that screen survives settings too.

## Inspect a scene

By default, a successful case cleans its temporary scene. A failed case keeps its scene:

```text
.e2e/
├── results/                 # Playwright traces and screenshots
└── runs/<timestamp>/
    ├── home/                # temporary HOME of this scene
    ├── logs/api.log         # stdout of the API process: the login link and start-up recovery
    ├── logs/web.log         # stdout of Vite
    ├── db/app.db            # the database of this scene
    └── project/             # the temporary repository and the files it changed
```

To open a trace, run `vp exec playwright show-trace .e2e/results/<case>/trace.zip`.

To inspect the logs, the database, the temporary repository, the screenshots, and the trace
of a successful case, set `E2E_KEEP_ARTIFACTS=1`:

```bash
E2E_KEEP_ARTIFACTS=1 vp run e2e
```

The scene of a successful case also stays in `.e2e/runs/<timestamp>/`, and the trace and
the screenshots stay in `.e2e/results/`. Without this variable, a successful case still
cleans its scene. A trace and screenshots still exist only after a failure.

## How it is built

`e2e/harness.ts` does this on every run:

- It makes a temporary directory, a temporary SQLite database, and a temporary `HOME`, so
  it does not touch your `~/.aify-zero`.
- `git init` plus one commit gives the review view a baseline.
- It starts the fake provider (inside the test process), the API child process, and the Vite
  dev server. The system picks every port.
- It writes the provider into the settings with a Bearer token. It uses the public
  interface and does not write the database.

The cases use only what a user can see: text, button names, and file content. The class
names and the DOM structure of the page are outside the assertions.

## Three traps

1. **A deep link lands on its page; a collapsed panel does not answer.** `app.tsx` builds the
   router on `createBrowserHistory` for the web and `createHashHistory` for the desktop, so
   `page.goto("/sessions/<id>")` opens that session and keeps the address. When the panel is
   collapsed, its content is `inert`. The buttons inside do not respond until you click the
   entry to expand the panel. A click waits until the timeout.
2. **`Start a session`, `Working`, `Finished`, and `Approve` are hard-coded English.** They
   do not change in Chinese either. If they enter i18n one day, the assertions fail. They
   should fail: change the assertions then.
3. **The `toolCall` of the fake provider only proves that the client parses it back into
   the same tool call.** The protocol-level test
   (`packages/agent/tests/testing/tool-call.test.ts`) proves that. It does not prove that
   the fake provider has the same shape as a real provider. Only a record and replay
   (`replay`) finds that drift.

## Add a case

A file is one scene and holds one or more cases: 13 files hold 16 cases. To add an approval
path (`write-file`, an MCP tool):

1. Add a scene in `packages/agent/scenarios/`. Use `toolCall` to request the tool that asks
   for approval.
2. Add a `*.e2e.ts` in `e2e/`. Use `startStack({ scenario: "..." })` to change the script,
   and continue the assertions after the click on `Approve`.
3. The default budget is 120 seconds, and no case retries. Four cases widen the budget for
   themselves: `approval-policy` 180 seconds, `outbox-hidden` 150, `schedule` 210, and
   `timer` 150.

End-to-end does not enter `vp run ready`. That command runs in the seconds before a commit.
End-to-end takes about 4.5 minutes. Mix the two, and both break.
