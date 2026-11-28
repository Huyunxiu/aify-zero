# Subagent acceptance

Read this page when the delegation feature must be proved by a person. The automated
suites cover the parts: `subagent.e2e.ts` drives one delegation through the browser, and
the two seams in `packages/agent/tests` cover the factory and the notice. This page covers
what no automated case reaches: the two answers that `Stop` offers, the recovery path after
a restart, and the model's own behaviour.

Run it before you merge a change to delegation. Record the result in the issue that asked
for the change.

## Set up the scene

The scene answers in a fixed order. It does not read what you type, so send the messages in
the order this page gives.

**Terminal 1 — the fake provider:**

```bash
vp run fake:provider -- --scenario subagent-stop --port 4030
```

**Terminal 2 — the application:**

```bash
vp dev
```

Open the login link that the application prints, add a provider whose base URL is
`http://127.0.0.1:4030/v1` (any key works, the fake provider does not check it), and add
the model it lists: `fake-fast`.

The scene starts over when you restart the fake provider. Do that between the two passes
below.

## Pass 1 — the chain, and the two answers of Stop

### 1. A delegation returns before the child does

Send this message:

> Start a subagent that finds the router

Right: a `Subagent` row appears; the turn ends with `Started AGENT-1. It will report when
it is done.`; the report is not on the page yet. The child waits 25 seconds before it
speaks, which is long enough for the next step.

### 2. Stop takes the child with it, and says nothing about it

While the child still runs, press `Stop`.

Right: the child's row turns `canceled`, and the parent's turn is canceled with it. Send
the next message. The transcript must not open with a notice about the stop: you asked for
it, and the report of a stop you asked for is noise.

### 3. Stop can leave the child running

Restart the fake provider, open a new session, and send the same message again. While the
child still runs, open the menu beside `Stop` and pick **Stop the reply, keep subagents
running**.

Right: the parent's turn ends; the child keeps working. It settles about 25 seconds later,
and **nothing happens on the screen** — the notice waits. Send any message: the notice
appears above the answer to it, so the parent reads the report before your new sentence.

### 4. A crash is reported to the parent

Restart the fake provider and open a new session. Send the same message, then kill the API
process in terminal 2 while the child still runs. Start it again.

Right: within a few seconds the session wakes by itself, a `Subagent finished` block appears
with the terminal state, and a turn answers it. This is the recovery path: the child's run
was settled by the new process, and the notice carried the payload that let the session
wake.

## Pass 2 — the prompt

Switch the session to a real provider and stop the fake one. Repeat one delegation, then
talk to the subagent by name.

Right:

- The model starts one subagent and ends its turn. It does not poll `list-agents` in the
  same turn.
- It repeats the name exactly, and it reaches the subagent with that name alone.
- When you ask it to message the subagent, its answer says whether the sentence applies
  now or at the next step boundary.
- When the notice arrives, the model uses the report it carries and does not call
  `list-agents` or `send-message` to fetch it again.

Write down what you saw in one sentence per point. Pass 2 cannot fail deterministically:
the model is what it tests.

## What each pass proves

| Pass | Proves                                                                      | Does not prove            |
| ---- | --------------------------------------------------------------------------- | ------------------------- |
| 1    | The wiring of the whole stack, both answers of `Stop`, and the restart path | Anything about the prompt |
| 2    | That the prompt makes the model delegate and stop                           | Anything about the code   |
