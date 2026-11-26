# An image is priced by its pixels

Context metering charged every image the same 1500 tokens. That number was a placeholder:
the estimator prices a model message, and a file part in a model message names only its
media type. The size was in the attachment reference, and the estimator never sees it.

The error runs both ways, and the low side is the common one. A full copy at the stored
budget is 1536 tokens at P/750, so 1500 was never the problem there. A 400x300 crop costs
about 160 tokens and was charged 1500: nine times too much, on every step of every turn
that history survives. `region` made that case normal. The estimate invents 27k tokens in a
session that crops twenty times, compaction fires early, and usable history is summarized
away.

The price now comes from the image itself. A file part still carries its bytes, so the
head answers the size question, and one formula serves every provider:

```
tokens = clamp(ceil(width * height / 750), 85, 1536)
```

P/750 is the Anthropic rule exactly and within ten percent of the OpenAI tile rule at the
sizes a read stores. 85 is one tile, the smallest charge a detail rule makes. 1536 is the
normalized pixel budget at P/750: a provider reduces an image to its own detail budget
before it charges, so nothing a read keeps costs more than this.

PNG, GIF, and WebP declare their size in the first 32 bytes. A JPEG hides its frame header
behind the metadata segments a camera writes, so the read widens to 4 KB, then to 64 KB,
before it decides the image declares no size. Anything unmeasured — that case, a URL, a
provider reference — takes the ceiling. Over-counting makes compaction early; under-counting
lets a request overflow after the money is spent.

## Considered Options

- **A resolver keyed by `toolCallId`**, supplied from the steps that still hold the
  reference: exact, and the key is already in the message. It needs the resolver threaded
  through four call sites, and it cannot price a user's own uploaded image, which belongs
  to no tool call.
- **Write the price into the message at projection**: the cheapest to consume. It puts a
  machine-readable number into what the model reads, and the model would read it.
- **Two ledgers**: estimate messages at the placeholder, then add the difference from the
  steps. Two sources of truth for one number, and the compaction threshold drifts between
  them.
- **Read the head of the bytes in the part** (this decision): no plumbing, one source of
  truth, and it covers uploaded images. It costs a base64 slice per priced part, and two
  more only for a JPEG.

## Consequences

- The estimate stays a pressure gauge, not a bill. The provider's reported usage remains
  authoritative wherever it exists.
- One formula cannot match every provider: a route that bills differently is off by about
  ten percent at the ceiling and by one tile at the floor.
- A PDF keeps its flat price. Its cost follows page count, which no header declares.
- An image part of the older `image` shape still prices by its serialized length. Nothing
  in this harness produces one, and the estimate errs high for it, which is the safe side.
