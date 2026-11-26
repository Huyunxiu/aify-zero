# A region is a fraction of the image

An image read reduces the whole picture to fit a pixel and a byte budget. That is the right
default and the wrong tool for detail: a 4K screenshot brought down to a 1568-pixel edge turns
12-pixel interface text into 5-pixel smudges, and the model can see that a label exists without
being able to read it. A crop is the only way to keep resolution: the same screenshot cut to a
quarter arrives at native pixels.

The read takes an optional `region` of four numbers, each a fraction of the image. A cropped read
does its work at source resolution, then the same budgets apply to what is left.

Fractions, not pixels, because the model forms its region from the copy it already saw, which is
smaller than the source. A fraction transfers without arithmetic; a source-pixel box needs the
multiplier applied first, and one wrong multiplication crops the wrong place. Fractions also stay
correct when the same instruction is applied to a different file.

The envelope reports both spaces, because two different coordinates matter: the region as a
fraction, for a repeated read, and the region's box in source pixels, for a coordinate measured
inside the copy.

## Considered Options

- **Source pixels**: the unit a future click tool would use. It forces the reader to multiply
  before every crop, and an unstated assumption about which image the numbers refer to.
- **Displayed pixels of the last copy**: matches what the model just saw. The read is stateless,
  so it cannot know which copy that was.
- **Fractions** (this decision): independent of resolution and of which copy the model looked at.
  It costs a multiplication in the envelope, printed once, instead of in every request.
- **No region at all, and a downscale-only read**: simplest. It leaves screenshots and dense
  documents unreadable, which is the case this feature exists for.

## Consequences

- The parameter only means something for an image. A document ignores it, and a deployment with
  no decoder refuses it rather than reading the whole file and letting the model believe it
  cropped.
- A cropped read stores a new object: the digest differs, so the whole-image copy is untouched and
  both can be read again.
- A crop that is still larger than the budget is reduced like any other image, and the envelope
  says which multiplier maps the delivered copy back into the region.
