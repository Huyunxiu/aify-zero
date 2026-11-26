# A request body is asserted where the protocol builds it

`AIFY0-137` (ADR 0039) moved a tool result's files into a user message for the chat
protocol, and the test that guards it stops at the messages handed to `streamText`. Those
messages are not what leaves the process. The provider adapter turns them into an HTTP
body, and that is where the defect lived: `@ai-sdk/openai-compatible` serializes a tool
result's content as text unless `supportsMultiPartToolContent` is set. An SDK change to
that default would leave the guard green while the model read base64 again.

The repository already names the missing hop. `ADR 0011` recorded it: the tests replace
`streamText`, so the way from `gateway.ts` to `OpenAICompatibleChatLanguageModel` had no
test at all. The third layer of `docs/testing/fake-provider.md` ("协议与 HTTP") is where it
belongs, and that layer only tested the fake provider by posting to it directly.

So one case drives a real Agent through a real HTTP request to the fake provider, and reads
the body of the request that follows the `read-file` call: the tool message carries no file
part, and the message after it is a `user` message holding an `image_url`. A file part is
the defect, because the chat protocol writes it into the message as text.
The fake provider records the parsed body of every request it answers, so the assertion
reads the recorded body of that request instead of a side channel.

## Considered Options

- **Inject a `fetch` into the provider and read `result.request.body`**: no port, and the
  SDK hands the body back. It needs a canned SSE response, which is a second place that
  knows how the chat protocol frames a stream; `ADR 0011` exists to keep that knowledge in
  one writer per protocol.
- **Intercept `fetch` with `msw`**: no port either, and it can assert bodies. `ADR 0011`
  rejected it once and the reasons hold: it intercepts a library call rather than the
  protocol, it does not serve the manual flow, and the framing still has to be written.
- **`MockLanguageModelV4` from `ai/test`**: the smallest mock. It replaces the model object,
  which is exactly the code that builds the body, so it cannot fail on this defect.
- **A real provider in CI**: the strongest evidence. It costs money, answers
  non-deterministically, and `ADR 0011`'s record mode already replays a captured response
  for the shapes a fake cannot produce.
- **The fake provider over HTTP** (this decision): no protocol knowledge is duplicated, the
  case runs in seconds, and it fails when the wire changes.

## Consequences

- A failing case means the request body changed, not that an internal shape did. That is the
  signal this guard is for.
- The fake provider keeps every body it answers for the length of a case. A scenario has no
  size limit, so a case that posts large images holds them in memory; tests are short.
- The browser suite seeds a model that declares image input. A case that reads an image would
  otherwise pass while the image was replaced by a sentence in request assembly.
- Chat only. The fake provider speaks one protocol, and a `responses` writer is its own
  change; the responses path stays asserted at request assembly until then.
