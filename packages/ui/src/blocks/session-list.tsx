import { SidebarMenu } from "@workspace/ui/components/sidebar";
import type { ComponentProps } from "react";

import { cn } from "../lib/utils";

/**
 * The list that holds the session rows of one Bot or one Project.
 *
 * It owns two decisions that the two call sites would repeat and drift on: the
 * spacing of the rows, and the indent that puts a session title under the name
 * of the row above it.
 */
export function SessionList({ className, ...props }: ComponentProps<"ul">) {
  return (
    <SidebarMenu className={cn("gap-1 py-2 pl-2.5", className)} {...props} />
  );
}
