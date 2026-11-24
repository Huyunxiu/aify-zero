import { cn } from "../lib/utils";

/**
 * 图标键到资源地址。
 *
 * 键名即文件名去掉 `.svg`：带 `-color` 后缀的是彩色图，其余是单色图。加一张图
 * 不用改这个文件。
 */
const ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob("../assets/icons/*.svg", {
      eager: true,
      query: "?url",
      import: "default",
    })
  ).map(([path, url]) => [
    path.slice(path.lastIndexOf("/") + 1, -".svg".length),
    url,
  ])
);

/** 中性图标：认不出的品牌用它，免得行首一空一有。 */
const GENERIC_PATH =
  "M8 2.2 13.2 5.1v5.8L8 13.8 2.8 10.9V5.1Z M8 8v5.8 M2.8 5.1 8 8l5.2-2.9";

/** 全部图标键。`generic` 不在其中，它不是文件。 */
export const ICON_KEYS: readonly string[] = Object.keys(ICONS);

/** 键表里有没有这个键。`generic` 不是文件，也算有。 */
export function hasIcon(key: string): boolean {
  return key === "generic" || key in ICONS;
}

interface BrandIconProps {
  name: string;
  className?: string;
}

/**
 * 一张品牌图。
 *
 * 彩色图用 `<img>` 画原色；单色图用 mask，颜色跟随文字，深色主题下也看得见。
 * 键不存在时画中性图标，不画别的品牌的图。
 */
export function BrandIcon({ name, className }: BrandIconProps) {
  const src = ICONS[name];

  if (name === "generic" || !src) {
    return (
      <svg
        aria-hidden="true"
        className={cn("size-4 shrink-0", className)}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.4}
        viewBox="0 0 16 16"
      >
        <path d={GENERIC_PATH} />
      </svg>
    );
  }

  if (name.endsWith("-color")) {
    return (
      <img
        alt=""
        aria-hidden="true"
        className={cn("size-4 shrink-0 object-contain", className)}
        draggable={false}
        src={src}
      />
    );
  }

  const maskImage = `url("${src}")`;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-4 shrink-0 bg-current", className)}
      style={{
        WebkitMaskImage: maskImage,
        WebkitMaskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskImage,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "contain",
      }}
    />
  );
}
