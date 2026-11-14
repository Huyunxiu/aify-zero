import { cn } from "@workspace/ui/lib/utils";

export type SettingFrameProps = React.ComponentProps<"div">;

export function SettingFrame({ className, children }: SettingFrameProps) {
  return (
    <div className={cn("flex w-full rounded-lg border flex-col", className)}>
      {children}
    </div>
  );
}
