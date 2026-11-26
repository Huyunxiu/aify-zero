/**
 * How an attachment reads once a model may not see it.
 *
 * Two places need the same sentence: the size pruner caps an old tool result, and
 * the input gate hides an image from a route that cannot take one. Both must say
 * what the reader no longer has and how to get it back, so the text lives here.
 *
 * @module
 */

/** The one-line stand-in for an attachment, with the path a re-read needs. */
export function attachmentStubText(
  name: string | undefined,
  mediaType: string
): string {
  const label = name ?? "attachment";
  return `[Attached file ${label} (${mediaType}); read it again with read-file if you need it]`;
}

/** The stand-in for an image this route cannot receive, which says it was not seen. */
export function unseenImageText(
  name: string | undefined,
  mediaType: string
): string {
  const label = name ?? "attachment";
  return `[Attached file ${label} (${mediaType}). This model cannot see images; you did not see its content.]`;
}
