import { MessageResponse } from "../message";

/**
 * The copy controls every Markdown body inside a step shares.
 *
 * Declared once so a view states only that its body is Markdown.
 */
const STEP_CONTROLS = {
  code: {
    copy: true,
    download: false,
  },
  table: {
    copy: true,
    download: false,
    fullscreen: false,
  },
  mermaid: {
    copy: true,
    download: false,
    fullscreen: false,
    panZoom: true,
  },
} as const;

/**
 * A step's Markdown body.
 *
 * The renderer and its controls are the transcript's own, so a note, a
 * reasoning block, a skill, and a compaction summary all read alike.
 */
export const MarkdownBody = ({ text }: { text: string }) => (
  <MessageResponse controls={STEP_CONTROLS}>{text}</MessageResponse>
);
