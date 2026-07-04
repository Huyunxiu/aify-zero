export type SettingFrameProps = React.ComponentProps<"div">;

export function SettingFrame({ children }: SettingFrameProps) {
  return <div className="flex w-full rounded-lg border">{children}</div>;
}
