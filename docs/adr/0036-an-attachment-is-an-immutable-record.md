# An attachment is an immutable record

`read-file` already handed images and PDFs to the model, but it did that by putting the
whole file into the tool result as base64. The result is one JSON column per step, so the
bytes entered the database, were replayed on every request, and cost the encoded length in
the token estimate. Nothing bounded the read either: `readFileBuffer` took whatever the file
was, so a large photo could take the memory of the agent process.

The read now records a reference instead of the bytes: a digest, the media type, the size,
the owner, and the path it came from. The bytes are written once under
`<sessionDir>/attachments/<sha256>`, and the request builds the file part from that object.

An attachment is not an asset, and the two do not share a name. An asset is a mutable file an
owner replaces by name (`ADR 0034`); its address stays the same while its bytes change, so
the byte route redirects to a version. An attachment address names one set of bytes forever,
so the route serves it with an immutable cache and no redirect. A transcript must replay the
bytes a read produced; an address that a later upload can overwrite cannot do that.

## Considered Options

- **Reuse the asset channel** (`<sessionDir>/assets/`, `GET /api/asset`): no new route, and
  the interface already renders an asset. It loses the one property the record needs, because
  an asset name can be overwritten; it also caps images at the asset limit of 2 MB and accepts
  no GIF, which a read must not inherit from an avatar.
- **Keep base64 in the step and cap it**: no storage, no route, no new concept. The bytes still
  ride every request and every row, and the cap only changes which file is refused.
- **A content-addressed store** (this decision): one object per distinct content, no collector,
  and a replay that cannot drift. It costs a second byte route and a write that the asset
  channel would not have needed.
- **A local S3-compatible daemon**: a second process and a lifecycle the desktop does not own,
  which is the reason `ADR 0034` did not take it for assets either.

## Consequences

- Two reads of the same file cost one object. The name is the digest, so a concurrent writer
  cannot publish different bytes under the same address.
- Nothing collects the objects. A session row is deleted softly and its directory stays, which
  is what `ADR 0034` already says about assets.
- The stored bytes are the source bytes: this change has no decoder, so the byte limit is a
  refusal and not a resize. A later normalization step replaces the refusal with a smaller
  derived object, and it needs no change to the reference.
- A refusal at the tool is a sentence; a history whose image the current route cannot read is
  replaced by a sentence at request assembly. One predicate answers both, because a session can
  change models while its transcript keeps the images an earlier model read (`ADR 0027`).
