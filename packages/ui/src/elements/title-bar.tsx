import * as React from "react";

import { cn } from "../lib/utils";

type TitleBarProps = React.ComponentProps<"div">;

function TitleBar({ className, children }: TitleBarProps) {
  return (
    <div className={cn("h-12 [-webkit-app-region:drag]", className)}>
      {children}
    </div>
  );
}

export { TitleBar, type TitleBarProps };
