import { FilePenIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ToolPanels, ToolRenderedSection } from "../tool-panels";
import { StepFrame, StepLabel, StepShell } from "./shell";
import { summarizeTool } from "./summary";
import type { StepPartOf, StepViewProps } from "./types";

/** Flattens one replacement block into `-` and `+` rows, so a step reads as a diff. */
const diffLines = (oldString: string, newString: string) => [
  ...oldString.split("\n").map((text) => ({ sign: "-" as const, text })),
  ...newString.split("\n").map((text) => ({ sign: "+" as const, text })),
];

/**
 * Parses a display diff line the tool returned, in the form `+ 12 content`. The
 * first character is the sign; the rest — line number and text — is shown as is.
 */
const parseRenderedDiffLine = (line: string) => ({
  sign: line[0] ?? " ",
  text: line.slice(1),
});

/**
 * The rows of an edit's diff: the tool's own diff once it finished, and a
 * preview built from the input before that.
 *
 * The two sources once rendered on their own, so the copy button had nothing to
 * copy. The rows are the one form that the panel and the clipboard both read.
 */
export const editDiffRows = (
  part: StepPartOf<"tool-edit-file">
): { sign: string; text: string }[] => {
  const actualDiff = part.output?.metadata?.diff;

  if (actualDiff) {
    return actualDiff.split("\n").map(parseRenderedDiffLine);
  }

  // While streaming, `input` is a partial, so an unfinished edit block is not
  // drawn yet.
  return (part.input?.edits ?? []).flatMap((block) =>
    typeof block?.oldText === "string" && typeof block?.newText === "string"
      ? diffLines(block.oldText, block.newText)
      : []
  );
};

export const editDiffText = (part: StepPartOf<"tool-edit-file">): string =>
  editDiffRows(part)
    .map((row) => `${row.sign}${row.text}`)
    .join("\n");

export const editFileSummary = (
  part: StepPartOf<"tool-edit-file">
): ReactNode | undefined =>
  summarizeTool(part, ({ metadata }) => {
    if (!metadata) {
      return;
    }

    return (
      <>
        <span className="text-green-600 tabular-nums">
          +{metadata.linesAdded}
        </span>
        <span className="text-destructive tabular-nums">
          {" −"}
          {metadata.linesRemoved}
        </span>
        {metadata.replacements > 1 && ` · ${metadata.replacements} blocks`}
      </>
    );
  });

/**
 * A file a call changed in place.
 *
 * The diff is drawn between the input and the output: what was asked for, what
 * it actually wrote, and what came back.
 */
export const EditFileStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewProps<"tool-edit-file">) => (
  <StepShell
    approvalPart={part}
    body={
      <StepFrame title="Edit">
        <ToolPanels onRespond={onRespond} part={part}>
          <ToolRenderedSection copyValue={editDiffText(part)} label="Diff">
            <div className="wrap-break-word font-mono text-xs whitespace-pre-wrap">
              {editDiffRows(part).map((row, index) => (
                <div
                  key={index}
                  className={
                    row.sign === "-"
                      ? "text-destructive"
                      : row.sign === "+"
                        ? "text-green-600"
                        : "text-muted-foreground"
                  }
                >
                  {row.sign}
                  {row.text}
                </div>
              ))}
            </div>
          </ToolRenderedSection>
        </ToolPanels>
      </StepFrame>
    }
    duration={duration}
    icon={<FilePenIcon />}
    label={<StepLabel action="Edit" detail={part.input?.path} />}
    onRespond={onRespond}
    status={status}
    summary={editFileSummary(part)}
  />
);
