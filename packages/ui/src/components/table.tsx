import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

import { ScrollArea } from "./scroll-area"

function Table({
  className,
  viewportClassName,
  ...props
}: React.ComponentProps<"table"> & { viewportClassName?: string }) {
  return (
    <ScrollArea
      className="w-full rounded-md border border-border"
      orientation="both"
      viewportClassName={cn("scroll-fade-both", viewportClassName)}
    >
      <table
        data-slot="table"
        className={cn(
          "w-full border-collapse caption-bottom text-sm",
          className
        )}
        {...props}
      />
    </ScrollArea>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn(
        "[&_tr]:border-b [&_tr]:border-border [&_tr]:bg-muted/60 [&_tr:hover]:bg-muted/60",
        className
      )}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t border-border bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-border transition-colors hover:bg-muted/40 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-8 border-r border-border px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground last:border-r-0 [&[align=center]]:text-center [&[align=right]]:text-right [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "border-r border-border px-3 py-1.5 align-middle whitespace-nowrap last:border-r-0 [&[align=center]]:text-center [&[align=right]]:text-right [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-3 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
