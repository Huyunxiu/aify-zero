/**
 * 编辑工具的纯文本处理层：换行符/BOM 保真、模糊匹配、批量替换与行数统计。
 *
 * 匹配和替换的语义是这个工具自己的契约（唯一、互不重叠、原文匹配），
 * 没有现成库可以直接替代；只有“改前/改后的行级差异”交给 jsdiff。
 */

import { diffLines } from "diff";

export interface Edit {
  oldText: string;
  newText: string;
}

export interface AppliedEditsResult {
  baseContent: string;
  newContent: string;
}

export interface FuzzyMatchResult {
  /** 是否找到了匹配 */
  found: boolean;
  /** 匹配起始位置（相对于 `contentForReplacement`） */
  index: number;
  /** 匹配到的文本长度 */
  matchLength: number;
  /** 是否退回了模糊匹配（false 表示精确匹配） */
  usedFuzzyMatch: boolean;
  /**
   * 实际用于替换的内容。
   * 精确匹配时就是原内容；模糊匹配时是归一化后的内容。
   */
  contentForReplacement: string;
}

/** 剥掉开头的 UTF-8 BOM，返回 BOM 与剩余正文。 */
export function splitBom(content: string): { bom: string; text: string } {
  // 用码点判断而不是直接写 BOM 字符：源码里那个字符不可见，很容易被误删。
  if (content.codePointAt(0) !== 0xfe_ff) {
    return { bom: "", text: content };
  }
  return { bom: content.slice(0, 1), text: content.slice(1) };
}

/** 检测文件主要使用的换行符；全文没有换行时按 LF 处理。 */
export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIndex = content.indexOf("\r\n");
  const lfIndex = content.indexOf("\n");
  if (lfIndex === -1 || crlfIndex === -1) {
    return "\n";
  }
  return crlfIndex < lfIndex ? "\r\n" : "\n";
}

/** 把 CRLF 和单独的 CR 都统一成 LF，便于匹配。 */
export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 把 LF 还原成文件原本的换行符。 */
export function restoreLineEndings(
  text: string,
  ending: "\r\n" | "\n"
): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * 统计改前/改后的增删行数，语义与 `git diff` 一致。
 *
 * 必须对最终内容做逐行比较，而不是根据 oldText/newText 猜：
 * 模糊匹配实际命中的原文可能和模型给的不一样，只有真实 diff 才准确。
 */
export function countLineChanges(
  before: string,
  after: string
): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) {
      linesAdded += part.count;
    } else if (part.removed) {
      linesRemoved += part.count;
    }
  }
  return { linesAdded, linesRemoved };
}

/**
 * 生成面向展示的 diff：带行号，只保留改动前后的少量上下文。
 *
 * 和 `countLineChanges` 一样基于最终内容计算，因此模糊匹配改写掉的
 * 引号、行尾空白也会如实出现，而不是照抄模型给出的 oldText/newText。
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4
): { diff: string; firstChangedLine: number | undefined } {
  const parts = diffLines(oldContent, newContent);
  const output: string[] = [];

  const maxLineNum = Math.max(
    oldContent.split("\n").length,
    newContent.split("\n").length
  );
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts.at(i);
    if (!part) {
      continue;
    }

    // 按行切开后去掉末尾的空串，避免把结尾换行算成一行。
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }

    if (part.added || part.removed) {
      firstChangedLine ??= newLineNum;

      for (const line of lines) {
        if (part.added) {
          output.push(
            `+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`
          );
          newLineNum++;
        } else {
          output.push(
            `-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`
          );
          oldLineNum++;
        }
      }
      lastWasChange = true;
      continue;
    }

    // 未改动的上下文：只保留紧挨改动的前后各 contextLines 行。
    const nextPart = parts.at(i + 1);
    const hasLeadingChange = lastWasChange;
    const hasTrailingChange = Boolean(nextPart?.added || nextPart?.removed);

    if (hasLeadingChange && hasTrailingChange) {
      if (lines.length <= contextLines * 2) {
        for (const line of lines) {
          output.push(
            ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`
          );
          oldLineNum++;
          newLineNum++;
        }
      } else {
        const leadingLines = lines.slice(0, contextLines);
        const trailingLines = lines.slice(-contextLines);
        const skippedLines =
          lines.length - leadingLines.length - trailingLines.length;

        for (const line of leadingLines) {
          output.push(
            ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`
          );
          oldLineNum++;
          newLineNum++;
        }

        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skippedLines;
        newLineNum += skippedLines;

        for (const line of trailingLines) {
          output.push(
            ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`
          );
          oldLineNum++;
          newLineNum++;
        }
      }
    } else if (hasLeadingChange) {
      const shownLines = lines.slice(0, contextLines);
      const skippedLines = lines.length - shownLines.length;

      for (const line of shownLines) {
        output.push(
          ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`
        );
        oldLineNum++;
        newLineNum++;
      }

      if (skippedLines > 0) {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skippedLines;
        newLineNum += skippedLines;
      }
    } else if (hasTrailingChange) {
      const skippedLines = Math.max(0, lines.length - contextLines);
      if (skippedLines > 0) {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skippedLines;
        newLineNum += skippedLines;
      }

      for (const line of lines.slice(skippedLines)) {
        output.push(
          ` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`
        );
        oldLineNum++;
        newLineNum++;
      }
    } else {
      // 距离改动太远，整段跳过。
      oldLineNum += lines.length;
      newLineNum += lines.length;
    }

    lastWasChange = false;
  }

  return { diff: output.join("\n"), firstChangedLine };
}

/**
 * 生成模糊匹配用的归一化文本：
 * - 去掉每行行尾空白
 * - 智能引号转成 ASCII 引号
 * - Unicode 破折号统一成 `-`
 * - 特殊空白统一成普通空格
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // 智能单引号 → '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // 智能双引号 → "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // 各种破折号/连字符 → -
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // 不换行空格等特殊空白 → 普通空格
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}

/** 按行切分，并保留每行末尾的换行符。 */
function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
  start: number;
  end: number;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

type TextReplacement = Pick<
  MatchedEdit,
  "matchIndex" | "matchLength" | "newText"
>;

/** 计算每一行在内容中的字符区间。 */
function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

/** 找出一次替换实际覆盖到的行区间（end 为开区间）。 */
function getReplacementLineRange(
  lines: LineSpan[],
  replacement: TextReplacement
): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;

  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    throw new Error("Replacement range is outside the base content.");
  }

  let endLine = startLine;
  while (endLine < lines.length) {
    const line = lines[endLine];
    if (!line || line.end >= replacementEnd) {
      break;
    }
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error("Replacement range is outside the base content.");
  }

  return { startLine, endLine: endLine + 1 };
}

/** 倒序应用替换，保证前面的下标不因长度变化而失效。 */
function applyReplacements(
  content: string,
  replacements: TextReplacement[],
  offset = 0
): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    if (!replacement) {
      continue;
    }
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.slice(0, matchIndex) +
      replacement.newText +
      result.slice(matchIndex + replacement.matchLength);
  }
  return result;
}

/**
 * 把在 `baseContent` 上算出的替换应用到 `originalContent`：
 * 只有被替换覆盖到的行从归一化文本重写，其余行保留原始字节。
 *
 * 这样模糊匹配（会改写引号、行尾空白等）不会污染未改动的行。
 */
export function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[]
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error(
      "Cannot preserve unchanged lines because the base content has a different line count."
    );
  }

  const groups: {
    startLine: number;
    endLine: number;
    replacements: TextReplacement[];
  }[] = [];
  const sortedReplacements = [...replacements].toSorted(
    (a, b) => a.matchIndex - b.matchIndex
  );
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups.at(-1);
    if (current && range.startLine < current.endLine) {
      // 同一行附近的替换合并成一组，避免行级重写互相覆盖。
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }

  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");

    const groupStart = baseLines[group.startLine];
    const groupEnd = baseLines[group.endLine - 1];
    if (!groupStart || !groupEnd) {
      throw new Error("Replacement range is outside the base content.");
    }
    result += applyReplacements(
      baseContent.slice(groupStart.start, groupEnd.end),
      group.replacements,
      groupStart.start
    );
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");

  return result;
}

/**
 * 先在原内容里找精确匹配；找不到再用归一化文本找模糊匹配。
 *
 * 模糊匹配返回的下标位于 `contentForReplacement`（归一化文本）中，
 * 调用方需要用同一份文本计算替换，再把改动按行覆盖回原内容。
 */
export function fuzzyFindText(
  content: string,
  oldText: string
): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  };
}

/** 统计（模糊归一化后的）文本出现次数，用于唯一性校验。 */
function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(
  path: string,
  editIndex: number,
  totalEdits: number
): Error {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
    );
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`
  );
}

function getDuplicateError(
  path: string,
  editIndex: number,
  totalEdits: number,
  occurrences: number
): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`
  );
}

function getEmptyOldTextError(
  path: string,
  editIndex: number,
  totalEdits: number
): Error {
  if (totalEdits === 1) {
    return new Error(`oldText must not be empty in ${path}.`);
  }
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
    );
  }
  return new Error(
    `No changes made to ${path}. The replacements produced identical content.`
  );
}

/**
 * 把一组编辑应用到 LF 归一化后的内容上。
 *
 * 所有编辑都基于同一份原始内容匹配（不是逐条累积），随后倒序应用；
 * 任意一条需要模糊匹配时，整个操作在归一化空间里计算，再把改动按行
 * 覆盖回原内容，未改动的行保持原样。
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string
): AppliedEditsResult {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    if (edit && edit.oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }

  const initialMatches = normalizedEdits.map((edit) =>
    fuzzyFindText(normalizedContent, edit.oldText)
  );
  const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
  const replacementBaseContent = usedFuzzyMatch
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    if (!edit) {
      continue;
    }
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
    if (!matchResult.found) {
      throw getNotFoundError(path, i, normalizedEdits.length);
    }

    const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
    if (occurrences > 1) {
      throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1];
    const current = matchedEdits[i];
    if (
      previous &&
      current &&
      previous.matchIndex + previous.matchLength > current.matchIndex
    ) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`
      );
    }
  }

  const baseContent = normalizedContent;
  const newContent = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(
        normalizedContent,
        replacementBaseContent,
        matchedEdits
      )
    : applyReplacements(replacementBaseContent, matchedEdits);

  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length);
  }

  return { baseContent, newContent };
}
