# A session outlives the route

A session holds live state that no address can rebuild: an open session event
stream, the draft in the composer, the chosen model, the scroll position. The
session was rendered by a route, so any route that replaced it unmounted the
session, closed the stream and threw the draft away. Settings then became a
route, which made that loss reachable from the screen the reader was looking at.

The session now lives in a pathless `_shell` layout. A route below that layout
can paint over the session instead of replacing it. The route that covers says
so with `staticData.coversSession`; the shell asks that question, so a new
section under `/settings` inherits the answer from its layout route, and the
shell never learns an address.

A covered session keeps streaming. It is only not read: the read mark still
needs the document visible and the session uncovered (ADR 0020), so a turn that
ends behind settings still produces its notice.

## Considered Options

- **Lift the session state into a module-level store**: it would survive any
  navigation, but a remount still loses the draft, the caret, the terminal size
  and the scroll position, because those live in the DOM.
- **Nest settings under the session route**: the parent route keeps its component
  mounted, so nothing is lost. But the address of settings would then depend on
  the session, and the session list could not open settings at all.
- **Render the session in the root route component**: that keeps the session
  mounted too, but "which addresses may cover a session" would become a list of
  path checks in a component that does not know what those addresses are.

## Consequences

- The routes under the shell render no session. They carry the address, the
  params and the search; the shell renders the session.
- A covered session is also inert for the reader: the shell marks it `inert`,
  and the dialog above it owns the focus trap.
- Closing settings walks back in history. A visit that starts at `/settings`
  lands on the session list instead, because there is nothing to walk back to.
