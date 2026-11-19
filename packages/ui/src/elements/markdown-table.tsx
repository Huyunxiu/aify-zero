import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table";
import * as React from "react";
import type { Components, ExtraProps } from "streamdown";
import { TableCopyDropdown, TableDownloadDropdown } from "streamdown";

// The table is the shadcn Table, so its styles have one source. The copy and
// download buttons stay from Streamdown: they find the table through the nearest
// [data-streamdown="table-wrapper"].
function MarkdownTable({
  children,
  node: _node,
  ...props
}: React.ComponentProps<"table"> & ExtraProps) {
  return (
    <div className="my-4 flex flex-col gap-1.5" data-streamdown="table-wrapper">
      <div className="flex items-center justify-end gap-0.5">
        <TableCopyDropdown />
        <TableDownloadDropdown />
      </div>
      <Table {...props}>{children}</Table>
    </div>
  );
}

function MarkdownTableHeader({
  node: _node,
  ...props
}: React.ComponentProps<"thead"> & ExtraProps) {
  return <TableHeader {...props} />;
}

function MarkdownTableBody({
  node: _node,
  ...props
}: React.ComponentProps<"tbody"> & ExtraProps) {
  return <TableBody {...props} />;
}

function MarkdownTableRow({
  node: _node,
  ...props
}: React.ComponentProps<"tr"> & ExtraProps) {
  return <TableRow {...props} />;
}

function MarkdownTableHead({
  node: _node,
  ...props
}: React.ComponentProps<"th"> & ExtraProps) {
  return <TableHead {...props} />;
}

function MarkdownTableCell({
  node: _node,
  ...props
}: React.ComponentProps<"td"> & ExtraProps) {
  return <TableCell {...props} />;
}

export const markdownTableComponents: Components = {
  table: MarkdownTable,
  thead: MarkdownTableHeader,
  tbody: MarkdownTableBody,
  tr: MarkdownTableRow,
  th: MarkdownTableHead,
  td: MarkdownTableCell,
};
