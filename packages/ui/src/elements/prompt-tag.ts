import type { JSONContent } from "@tiptap/core";

import { i18n } from "../i18n";

export type PromptTag<T> = {
  /** Tag kind, e.g. "skill"; keys the localized label promptTag.<tag> */
  tag: string;

  /** Sticky pattern matching one serialized link at the current cursor position */
  pattern: RegExp;

  /**
   * Only parse the link when it starts the first line of the text. Commands
   * take effect only at the start of the message, so mid-text links stay
   * plain text.
   */
  startOnly?: boolean;

  /** Parse a matched mention link into its typed form */
  extract: (link: string) => T;

  /** Serialize typed data back into a mention link */
  render: (data: T) => string;

  /**
   * Derive the localized mention label shown in the editor from typed
   * data, e.g. { name: "x", path: "..." } -> "skill:x" ("技能:x" in
   * zh-CN). Also used to rebuild labels from a serialized link via
   * extract, so it stays the single source of truth for the label format.
   */
  renderLabel: (data: T) => string;
};

export type PromptSkill = {
  name: string;
  path: string;
};

export type PromptCompactCommand = {
  id: string;
};

/**
 * Union of commands parsed from a `[@id](command://id)` link. Each id maps
 * to its own variant, e.g. compact -> PromptCompactCommand. Add a new
 * variant here (and a case in PromptCommandTag.extract) for new commands.
 */
export type PromptCommand = PromptCompactCommand;

/**
 * Split a serialized mention link into its sigil-stripped value and its
 * destination, e.g. "[$browser](/path/SKILL.md)" -> { value: "browser",
 * destination: "/path/SKILL.md" }. Every tag serializes as
 * [<sigil><value>](<destination>), where the sigil is "$" or "@".
 */
const parseLink = (link: string) => {
  const match = /^\[[$@]([^\]]*)\]\(([^)]+)\)$/.exec(link);
  return { destination: match?.[2] ?? "", value: match?.[1] ?? "" };
};

/**
 * Localized mention label, e.g. zh-CN: (skill, commit) -> "技能:commit".
 * The tag name translates via promptTag.<tag>; the value is translated by
 * the caller (e.g. promptCommand.<id> for commands).
 */
const promptLabel = (tag: string, value: string) =>
  `${i18n.t(`promptTag.${tag}`, tag)}:${value}`;

export const PromptSkillTag: PromptTag<PromptSkill> = {
  tag: "skill",
  // e.g. [$browser](/Users/me/.agents/skills/browser/SKILL.md)
  pattern: /\[\$[^\]]+\]\([^)]+\)/y,
  extract: (link) => {
    const { value: name, destination: path } = parseLink(link);
    return { name, path };
  },
  render: (skill) => `[$${skill.name}](${skill.path})`,
  renderLabel: (skill) => promptLabel("skill", skill.name),
};

export const PromptCommandTag: PromptTag<PromptCommand> = {
  tag: "command",
  // e.g. [@compact](command://compact). The command:// scheme keeps ordinary
  // markdown links (e.g. [@user](https://example.com)) from parsing as
  // commands.
  pattern: /\[@[^\]]+\]\(command:\/\/[^)]+\)/y,
  startOnly: true,
  extract: (link) => {
    // The label mirrors the id (e.g. [@compact](command://compact)); the id
    // is read back from the destination, the machine-readable half.
    const id = parseLink(link).destination.replace(/^command:\/\//, "");
    switch (id) {
      case "compact": {
        return { id } satisfies PromptCompactCommand;
      }
      default: {
        // Unknown ids fall back to the base shape so the command still
        // round-trips through serialization.
        return { id };
      }
    }
  },
  render: (command) => `[@${command.id}](command://${command.id})`,
  // Command ids map to a known word, e.g. compact -> 压缩 in zh-CN; unknown
  // ids fall back to the raw id.
  renderLabel: (command) =>
    promptLabel("command", i18n.t(`promptCommand.${command.id}`, command.id)),
};

/**
 * Registry of mention types that serialize as markdown links. renderText
 * embeds attrs.id (the raw link) into the plain text; the editor scan and
 * paste rules parse it back. Patterns only match the link itself, not its
 * contents. Add a new entry (e.g. resource) to support more mention types.
 * Entries are tried in order, so the first match at a position wins.
 *
 * Typed as PromptTag<any> so extract and renderLabel stay correlated when
 * called on a union element: PromptTag<A> | PromptTag<B> loses the pairing
 * between extract's return type and renderLabel's parameter. The precise
 * types live on the individual tag exports.
 */
export const PROMPT_TAGS: PromptTag<any>[] = [PromptSkillTag, PromptCommandTag];

/**
 * Parse a command link at the very start of serialized text, e.g.
 * `[@compact](command://compact)`, into its typed form via
 * PromptCommandTag.extract. Returns undefined when the text doesn't start
 * with a command link.
 */
export const parseLeadingCommand = (
  text: string
): PromptCommand | undefined => {
  // Sticky patterns match at lastIndex; the editor scan leaves it wherever
  // it stopped, so pin it back to the start of the text here.
  PromptCommandTag.pattern.lastIndex = 0;
  const match = PromptCommandTag.pattern.exec(text);
  if (!match) {
    return undefined;
  }

  return PromptCommandTag.extract(match[0]);
};

/**
 * Rebuild a Tiptap doc from serialized plain text. Mention nodes are embedded
 * in the text as markdown links (see PROMPT_TAGS), so a scan restores them;
 * everything else stays plain text. Each newline starts a new paragraph, and
 * a blank line (two consecutive newlines) adds an empty paragraph.
 */
export const textToJSONContent = (text: string): JSONContent => {
  // Mention links are single-line, so scanning each line independently is
  // equivalent to scanning the whole text.
  const parseLine = (line: string, isFirstLine: boolean): JSONContent[] => {
    const content: JSONContent[] = [];
    let cursor = 0;
    let textStart = 0;

    const pushText = (end: number) => {
      if (end > textStart) {
        content.push({ type: "text", text: line.slice(textStart, end) });
      }
    };

    while (cursor < line.length) {
      let matched = false;

      for (const tagConfig of PROMPT_TAGS) {
        // startOnly tags (commands) only parse at the very start of the text
        if (tagConfig.startOnly && !(isFirstLine && cursor === 0)) {
          continue;
        }

        tagConfig.pattern.lastIndex = cursor;
        const match = tagConfig.pattern.exec(line);

        if (match) {
          pushText(cursor);
          content.push({
            type: "mention",
            attrs: {
              mentionSuggestionChar: "/",
              // Keep the raw link as id so copying the mention serializes
              // back to the same link (see renderText).
              id: match[0],
              label: tagConfig.renderLabel(tagConfig.extract(match[0])),
            },
          });
          cursor = tagConfig.pattern.lastIndex;
          textStart = cursor;
          matched = true;
          break;
        }
      }

      if (!matched) {
        cursor++;
      }
    }

    pushText(line.length);

    return content;
  };

  const paragraphs = text.split("\n");
  const content: JSONContent[] = [];
  let prevParagraph = undefined;
  for (const currParagraph of paragraphs) {
    if (currParagraph) {
      content.push({
        type: "paragraph",
        content: parseLine(currParagraph, prevParagraph === undefined),
      });
    } else if (!prevParagraph) {
      content.push({
        type: "paragraph",
      });
      // content.at(-1)?.content?.push({ type: "hardBreak" });
    }
    prevParagraph = currParagraph;
  }

  return { type: "doc", content };
};
