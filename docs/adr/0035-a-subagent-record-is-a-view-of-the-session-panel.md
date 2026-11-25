# A subagent's record is a view of the session panel

A subagent's transcript was shown by mounting a second whole session in a column beside
the first. That column was born inside the session route. When ADR 0027 moved the session
out of the routes and into the shell, the column moved with it, and a way of arranging two
records ended up in the component that owns a session's lifetime. The symptoms were
concrete: four columns in the worst case, a frame that still showed the previous session's
child, a selection a reload threw away, and a split ratio that reset.

The record is now a view of the session panel, beside the transcript it came from: one tab
per subagent, read-only, and no panel of its own. A subagent runs in its parent's sandbox,
so a second files, changes, or terminal panel would draw the same workspace twice.

The selection lives in the session address as `?subagent=<id>`. The address records the
selection and not what is visible: a change of tab does not touch it, and closing that tab
is what takes it back. The panel belongs to a session that has an id in its address, so the
session list screen — the entry point before the reader starts a session — has no panel and
selects nothing there.

## Considered Options

- **Keep the second session in a column**: it reuses the whole session and needs no new
  renderer. It costs four columns, leaves the selection in a module-level store with no
  address, and commits both panes to a split that resets.
- **A route of its own** (`/sessions/<parent>/agents/<child>`): it gets an address for
  free, but the reader loses the parent while reading the child, and the parent is what
  says whether the child is still at work.
- **A read-only record in a second column inside the session**: the parent stays visible. It
  spends a column that the panel already owns, and the panel already switches between
  views by tab.

## Consequences

- The record has one renderer. The session and the subagent view draw it, so the two
  cannot drift.
- A view that needs a session id cannot be created from the new-tab page: the views that
  page can create are listed apart from the view type.
- The content dispatch ends in an exhaustive check, so a view added without its branch
  fails to compile instead of drawing another view.
- The session is always the reader's own: the read-only shape it needed for the second
  column is gone.
- A read-only record draws no answer: the approval strip and the fork action are
  left out, not drawn and left inert. The row still says the call is held.
- A record is read from a session that has an address. The session list screen has no
  panel, so a `task` row there opens nothing: that screen is the one place where the old
  column worked and this view cannot.
