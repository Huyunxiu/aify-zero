/**
 * The face an avatar falls back to when there is no image: the first grapheme of the
 * name, upper-cased.
 *
 * A grapheme rather than a code point, because cutting an emoji or a name with a
 * combining mark in half draws a box.
 */
const SEGMENTER =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter() : null;

const firstGrapheme = (text: string): string | undefined => {
  if (SEGMENTER === null) {
    // Without Intl.Segmenter, a code point at least keeps a surrogate pair whole.
    const codePoint = text.codePointAt(0);
    return codePoint === undefined
      ? undefined
      : String.fromCodePoint(codePoint);
  }

  return SEGMENTER.segment(text)[Symbol.iterator]().next().value?.segment;
};

/** The first letter of a name; an empty name gets a placeholder instead of a blank. */
export function initialOf(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? "";

  if (trimmed === "") {
    return "?";
  }

  return (firstGrapheme(trimmed) ?? "?").toUpperCase();
}
