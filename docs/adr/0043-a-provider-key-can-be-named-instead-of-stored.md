# A provider key can be named instead of stored

A provider holds its own key. Settings stored that key in the same JSON as the URL and the model
list, so the secret lived in the SQLite file for as long as the provider existed and came back in
every settings read. That is a poor fit for two ways people run this app:

- An acceptance run or a CI job talks to a real provider. The key is already in the environment,
  and writing it into a throwaway database puts a copy somewhere nobody will clean up.
- A person runs the API in a container or under a service manager that already injects secrets.
  Typing the key into a form is a second source of truth, and the form is the worse one.

A provider row may now name an environment variable instead of carrying the key:

```json
{
  "id": "openai",
  "apiKey": "",
  "apiKeyEnv": "AIFY_PROVIDER_KEY_OPENAI",
  "models": []
}
```

The two are mutually exclusive, and the reference is resolved when a call is assembled.

## The name is limited to one namespace

`apiKeyEnv` has to start with `AIFY_PROVIDER_KEY_`. The setting and the provider's `baseURL` are
both written by whoever calls the API; without a namespace, that caller could name
`AWS_ACCESS_KEY_ID` as the key and point the provider at a server of their own, and the API would
send the value there. The prefix is a namespace, not a lock — the operator can still name any
variable inside it — but it removes the accidental and the hostile case in one rule.

The namespace also gives every deployment the same convention, so a CI job sets
`AIFY_PROVIDER_KEY_OPENAI: ${{ secrets.OPENAI_KEY }}` and changes nothing in the app.

## A missing value fails where a run starts

The key is read at the seam where a model request is built, not once at startup. Two consequences,
both wanted:

- A run for a provider whose variable is empty fails before it starts, with a message that names
  the variable. The other providers in the same settings are untouched.
- Changing the variable between calls changes the key. Nothing caches it.

A stored `apiKey` that is empty stays legal. Older rows have one, and turning a legal row into an
invalid one would delete it the next time settings are normalized. For the same reason, a stored row
that somehow holds both a key and a reference keeps the key and loses the reference when settings
are read: a key cannot be reconstructed, a variable name can, and the row's models would otherwise
disappear with it.

## What this does not do

An environment variable is not a vault. The same user can read it back: `ps eww`, or
`/proc/<pid>/environ` on Linux. This change removes persistence, not exposure. The protection that
actually holds is a short-lived, revocable key — one per acceptance run, revoked when the run ends.

## Alternatives rejected

- **A secret-manager tool** (1Password CLI, SOPS, Doppler). It solves where the key lives at rest,
  and it adds a dependency to every machine that runs acceptance. The environment variable is the
  one channel every operating system and every CI provider already has.
- **A local broker** that holds the key and forwards requests, so the app only sees a dummy key.
  This is the strongest version, and it was deferred: it has to forward streaming responses without
  buffering, which is a protocol-level piece of work with its own failure modes. It stays compatible
  with this shape — a broker only changes what `baseURL` points at.
- **An implicit override**, `AIFY_PROVIDER_<ID>_API_KEY`, winning over the stored value. Cheapest,
  and it makes two sources of truth for one field: the row says one thing, the call does another.
  The explicit field says which one is in force.

## Consequences

- The settings screen keeps the field and shows the variable name, but it cannot set or remove it:
  typing a key replaces the reference, and there is no path to a row with neither. Choosing a
  reference in the UI is a separate piece of work.
- A rejected name is reported as input validation, so the sentence that names the namespace travels
  in the validation issues rather than in the error message the screen shows. The provider dialog
  shows messages, so it shows "Input validation failed" for now.
- `setting/list-models` takes the same two shapes, because a provider whose key lives in the
  environment still has to be discovered before it can be saved.
- Everything that resolves a key goes through one function. A second place that read `apiKey`
  directly would quietly ignore the reference.
