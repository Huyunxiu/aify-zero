# An image is normalized once, at the read

A read used to pass the source bytes through. That works for a small screenshot and fails
for everything a person actually has: a phone photo is several megabytes of pixels the route
will shrink anyway, a photo taken sideways carries its rotation in EXIF where the model
cannot see it, a 16-bit PNG or a CMYK JPEG is a format some providers reject, and a HEIC from
a Mac is a format nothing here reads. The limits from the previous phase turned each of those
into a refusal, which is honest but useless: the user has an image and the assistant says no.

The read now decodes the image and stores a normalized copy: one frame, 8-bit, sRGB, no
metadata, at most 1568 px on the long edge and 1.15 MP in total, encoded as WebP inside 1 MB.
The stored bytes are the copy; the source file stays where it was. Dimensions of the source,
after orientation, are recorded on the reference, and the envelope tells the reader how to map
a coordinate it measured on the copy back onto the original.

The decoder is sharp, loaded on demand. A deployment whose native binary is missing keeps the
header-only path: it still knows the size, still refuses what it cannot handle, and still
answers. A packaged product stages the platform package, and a missing one fails the package
rather than shipping without the capability.

## Considered Options

- **Pass the source through and let the provider shrink it**: no dependency, no CPU. It keeps
  the orientation, depth, and format failures, and it pays to upload and replay bytes nobody
  will see at full size.
- **Normalize only when the source breaks a limit**: most reads of a prepared screenshot would
  skip the pass. It splits the stored form in two — sometimes WebP, sometimes PNG — so the
  route, the store, and the byte estimate each grow a second case.
- **Normalize always** (this decision): one stored form, one media type, one byte budget, and
  the coordinate note has a single meaning. It costs a decode and an encode on every image
  read, and it discards the original bytes.
- **Decode with an image library in JavaScript**: no native binary, portable. A pure-JS decoder
  for HEIC and 16-bit TIFF is slower and larger than the whole rest of the agent, and a 12 MP
  decode in JavaScript blocks the event loop.

## Consequences

- Every image costs a decode and an encode. The guards bound it: at most 64 MB compressed and
  100 MP decoded, so a decompression bomb is refused before the pixels exist.
- The stored copy is smaller than the source, so a transcript replay sends what the model saw
  and not a resized derivative of it.
- sharp is a native dependency with a per-platform package. It joins ripgrep, libsql, and
  node-pty in the packaging script; the fallback path is what runs when it is absent.
- The original is not kept. A reader who needs full resolution must read the file again, which
  is why the envelope keeps the source path and the multiplier.
