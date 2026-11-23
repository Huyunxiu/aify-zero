/**
 * Joins the blocks of one prompt with a blank line between them.
 *
 * A block that contributes nothing leaves no gap. This is the only place a
 * separator is written, so a section never has to know about its neighbours, and
 * the two assembly points (the session prompt and the subagent prompt) cannot
 * disagree about it.
 */
export function joinBlocks(blocks: readonly string[]): string {
  return blocks
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .join("\n\n");
}
