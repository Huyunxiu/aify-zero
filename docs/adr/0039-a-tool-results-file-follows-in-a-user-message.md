# A tool result's file follows in a user message

The tool result of an image read carries the bytes as a `file` part, and one gate decided
whether that part reached the model: `hideUnsupportedImages` asked what the **model** reads.
Nothing asked what the **protocol** carries, and the two questions have different subjects.

The chat protocol puts text in a tool message. `@ai-sdk/openai-compatible` writes the tool
output as a string unless `supportsMultiPartToolContent` is set, and this harness never sets
it, so the whole content array — a `file` part included — became one JSON string inside the
tool message, the file's bytes spelled as a map of numbers. The model read text, not pixels,
and every later step of the turn sent it again. The responses protocol was correct: it turns
the same part into an image.

One model route now answers both questions. `ModelRoute` holds the protocol and the input
kinds, `route()` reads it from the model target once per step, and request assembly applies
two rules in one place:

- A model that reads no image gets a sentence in place of the bytes.
- A protocol that puts no file in a tool result gets the files in a user message directly
  after the tool message, prefixed with a line that names the call they answer. Where the
  tool result would hold nothing else, it keeps a sentence instead of an empty part.

The order is the rule: the model gate runs first, so an image the model cannot read never
reaches a user message.

## Considered Options

- **Set `supportsMultiPartToolContent`**: one flag, no moving parts. It is not in the public
  options of the provider, and the chat protocol's own contract keeps a tool message to text;
  a provider that follows the contract would refuse the request that OpenAI accepts.
- **Keep the bytes in the tool result and say so**: no request reshaping. It is the current
  behaviour, and the model reads them as text: 1 MB of image becomes millions of characters
  per step.
- **Refuse the read on the chat protocol**: no bytes to move. The tool cannot know the
  protocol, because a patch moves the session between the call and the next request, and the
  refusal would remove a capability the responses protocol has.
- **Move the files to a user message** (this decision): the tool result keeps the sentence it
  already carried, the bytes arrive in a shape every protocol accepts, and the replay order
  does not change. It costs one rule and one message per step that reads a file.

## Consequences

- The stored history keeps the file in the tool result, as it was recorded. The move is a
  request rule, like the sentence rule, and it copies rather than edits.
- The responses protocol is unchanged, so the two protocols share every rule except this one.
- A tool result whose only content was a file keeps a line, because a part with no content is
  a part that some providers refuse.
- `ADR 0036` still holds: the attachment is the record, and the request is a view of it.
