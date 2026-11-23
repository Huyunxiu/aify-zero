# The read mark requires a visible page

The outbox answers "is anybody watching" with the `done` status of a session. In
the reasoning of ADR 0019, the renderer is gone once the desktop window closes.
In practice, closing a window on macOS is only a `hide()`: the tray keeps the
process, and the page keeps a connection to the session events. When a turn
settles, the hidden page still receives `run.end` and still marks the session
`idle`. The dispatcher then reads "it just finished and nobody saw it" as
"somebody saw it", and the system notice never fires — while a notice after a
closed window is the reason this feature exists.

## Decision

A page marks a session read only while `document.visibilityState === "visible"`.
It does nothing while hidden, and catches up on `visibilitychange` when the page
comes back.

Marking read also writes `expired_at` on every outbox row of that session that
has not been delivered yet: those rows point at turns the user has just seen.
Without this, the next run sets the session `done` again and the old rows pop up
beside the new one. The outbox query itself does not change: the session is
`done`, the race margin has passed, and the connection was registered earlier.
What changes is that "somebody watched" expires the pending rows early.

"Read" assumes that a person can see. A page that exists is not a page that a
person sees; the page itself is the only thing that knows.

A session that another route covers counts as unseen. Settings covers the
session, and the session keeps streaming behind it (ADR 0027). The page is
visible; the session is not. A covered session is therefore not read either.

## Considered Options

- **Let the desktop main process report visibility to the server**: one more IPC
  channel and one more piece of server state. The main process would also have to
  know which session the user is looking at, and today it does not; the page
  already knows.
- **Ignore the read mark and deliver to every subscriber**: a notice would then
  fire while the window is open and the session is on screen. Removing that noise
  leads back to visibility in the end.
- **Make "visible" a server concept**: the server cannot see a window, so it
  would ask the client to report it — the first option with an extra layer.

## Consequences

- A turn that settles while the window is in the tray or minimized stays `done`;
  the page marks it read when it comes back to the front, and the tick in the
  sidebar stays until then.
- Marking read expires the session's undelivered outbox rows. `delivered_at` and
  `expired_at` stay separate accounts.
- A window that is visible but parked on another session still counts as unseen
  for the first session, so its notice still fires. This matches the behaviour
  before this decision.
- A window that is fully covered by another window may still report `visible`.
  That is the edge of the visibility API and is outside this decision.
- A session covered by a route stays unread: a turn that ends behind settings
  still produces its notice.
- The browser does not subscribe to the outbox. This rule only affects the
  session screen that the desktop and the browser share.
