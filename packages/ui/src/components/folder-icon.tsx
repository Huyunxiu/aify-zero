import { useId } from "react";
import type { ComponentProps, CSSProperties } from "react";

import { cn } from "../lib/utils";

const FOLDER_BODY_PATH =
  "M38 0H176Q196 0 204 14L218 30Q224 38 246 38H562Q600 38 600 76V462Q600 500 562 500H38Q0 500 0 462V38Q0 0 38 0Z";

const DOC_LINE_WIDTHS = [78, 180, 140, 175, 126, 168, 110];

const ICON_CLASS =
  "absolute top-1/2 left-1/2 aspect-[6/5] w-full -translate-x-1/2 -translate-y-1/2 @container [perspective:220cqw] [perspective-origin:50%_60%] transition-transform duration-[600ms] ease-[cubic-bezier(0.2,0.85,0.25,1)] group-hover/folder:scale-[1.03] group-hover/folder-row:scale-[1.03] motion-reduce:transition-none";

const LAYER_CLASS =
  "absolute inset-0 size-full! overflow-visible";

const BACK_FILTER_CLASS =
  "[filter:drop-shadow(0_4cqw_4.6cqw_rgba(60,130,180,0.28))_drop-shadow(0_1.3cqw_2cqw_rgba(60,130,180,0.16))_drop-shadow(0_0.3cqw_0.7cqw_rgba(60,130,180,0.1))] dark:[filter:drop-shadow(0_4cqw_4.6cqw_rgba(0,0,0,0.45))_drop-shadow(0_1.3cqw_2cqw_rgba(0,0,0,0.3))]";

const DOC_CLASS =
  "[transform-box:fill-box] origin-center [filter:drop-shadow(0_3px_4px_rgba(0,30,60,0.18))] transition-transform duration-[550ms] ease-[cubic-bezier(0.2,0.85,0.25,1)] motion-reduce:transition-none dark:[filter:drop-shadow(0_3px_4px_rgba(0,0,0,0.45))]";

const DOC_REST_CLASS = {
  left: "[transform:translate(40px,80px)_rotate(6deg)]",
  middle: "[transform:translate(160px,66px)_rotate(-4deg)]",
  right: "[transform:translate(280px,80px)_rotate(6deg)]",
} as const;

const DOC_HOVER_CLASS = {
  left: "group-hover/folder:[transform:translate(32px,70px)_rotate(9deg)] group-hover/folder-row:[transform:translate(32px,70px)_rotate(9deg)]",
  middle:
    "group-hover/folder:[transform:translate(166px,52px)_rotate(-7deg)] group-hover/folder-row:[transform:translate(166px,52px)_rotate(-7deg)]",
  right:
    "group-hover/folder:[transform:translate(286px,76px)_rotate(5deg)] group-hover/folder-row:[transform:translate(286px,76px)_rotate(5deg)]",
} as const;

const DOC_OPEN_CLASS = {
  left: "[transform:translate(30px,54px)_rotate(11deg)]",
  middle: "[transform:translate(162px,36px)_rotate(-10deg)]",
  right: "[transform:translate(294px,60px)_rotate(3deg)]",
} as const;

const FRONT_BASE_CLASS = [
  "absolute inset-x-0 top-[21.6%] bottom-0 origin-bottom rounded-[6.333cqw]",
  "bg-[linear-gradient(180deg,rgba(0,40,75,0)_74%,rgba(0,40,75,0.28)_100%),linear-gradient(180deg,rgba(132,214,248,0.45)_0%,rgba(69,170,220,0.45)_100%)]",
  "[box-shadow:inset_0_0_0_0.67cqw_rgba(255,255,255,0.3),inset_0_0.25cqw_0_rgba(255,255,255,0.55)]",
  "backdrop-blur-[3.3cqw] backdrop-saturate-[1.1]",
  "transition-[top,border-radius,transform] duration-[600ms] ease-[cubic-bezier(0.2,0.85,0.25,1)] motion-reduce:transition-none",
  "dark:bg-[linear-gradient(180deg,rgba(0,20,40,0)_70%,rgba(0,20,40,0.4)_100%),linear-gradient(180deg,rgba(100,190,235,0.42)_0%,rgba(45,130,190,0.5)_100%)]",
  "dark:[box-shadow:inset_0_0_0_0.67cqw_rgba(255,255,255,0.14),inset_0_0.25cqw_0_rgba(255,255,255,0.3)]",
].join(" ");

const FRONT_HOVER_CLASS =
  "group-hover/folder:top-[24.8%] group-hover/folder:rounded-[3cqw_3cqw_6.333cqw_6.333cqw] group-hover/folder:[transform:translateZ(2.33cqw)_rotateX(-9deg)] group-hover/folder-row:top-[24.8%] group-hover/folder-row:rounded-[3cqw_3cqw_6.333cqw_6.333cqw] group-hover/folder-row:[transform:translateZ(2.33cqw)_rotateX(-9deg)]";

const FRONT_OPEN_CLASS =
  "top-[29%] rounded-[2.5cqw_2.5cqw_6.333cqw_6.333cqw] [transform:translateZ(3cqw)_rotateX(-13deg)]";

type FolderIconStyle = CSSProperties & {
  "--ui-fd-size"?: string;
};

export type FolderIconProps = Omit<ComponentProps<"span">, "children"> & {
  /**
   * Width and height of the icon. Numbers are pixels, strings accept any CSS
   * length. Defaults to 24px.
   */
  size?: number | string;
  /**
   * Accessible name for the icon. Omit it when the icon is decorative and sits
   * next to a visible label — it is then hidden from assistive technology.
   */
  label?: string;
  /**
   * Pins the folder open: the papers stay fanned and the front pocket stays
   * lowered, independently of hover. Hover still adds the subtle scale.
   */
  open?: boolean;
};

/**
 * Glass folder icon with the layered-document hover animation from affectUI.
 * Hovering the icon fans out the papers and tilts the frosted pocket. Add
 * `group/folder-row` to an ancestor (such as a list row) to trigger the same
 * animation from the whole row. Pass `open` to keep the folder open.
 */
export function FolderIcon({
  className,
  label,
  open = false,
  size = 24,
  style,
  ...props
}: FolderIconProps) {
  const uid = `ui-fd-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const paperId = `${uid}-paper`;
  const docId = `${uid}-doc`;
  const highlightId = `${uid}-hl`;
  const decorative = label === undefined || label.length === 0;
  const stateClass = open ? DOC_OPEN_CLASS : DOC_HOVER_CLASS;

  return (
    <span
      {...props}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : label}
      className={cn(
        "group/folder relative inline-block size-[var(--ui-fd-size)] flex-none overflow-visible align-middle leading-none @container",
        className
      )}
      data-open={open || undefined}
      data-slot="folder-icon"
      role={decorative ? undefined : "img"}
      style={
        {
          "--ui-fd-size": typeof size === "number" ? `${size}px` : size,
          ...style,
        } as FolderIconStyle
      }
    >
      <span aria-hidden="true" className={ICON_CLASS}>
        <svg
          aria-hidden="true"
          className={cn(LAYER_CLASS, BACK_FILTER_CLASS)}
          viewBox="0 0 600 500"
        >
          <defs>
            <filter
              height="120%"
              id={highlightId}
              width="120%"
              x="-10%"
              y="-10%"
            >
              <feGaussianBlur in="SourceAlpha" result="blur" stdDeviation="4" />
              <feOffset dy="3" in="blur" result="offset" />
              <feComposite
                in="blur"
                in2="offset"
                k2="1"
                k3="-1"
                operator="arithmetic"
                result="diff"
              />
              <feFlood floodColor="#fff" floodOpacity="0.65" />
              <feComposite in2="diff" operator="in" result="light" />
              <feComposite in="light" in2="SourceAlpha" operator="in" />
            </filter>
          </defs>
          <path
            className="fill-[#5bb7ea] dark:fill-[#3d8fc6]"
            d={FOLDER_BODY_PATH}
          />
          <path
            d={FOLDER_BODY_PATH}
            fill="#000"
            filter={`url(#${highlightId})`}
          />
        </svg>

        <svg aria-hidden="true" className={LAYER_CLASS} viewBox="0 0 600 500">
          <defs>
            <linearGradient id={paperId} x1="0" x2="0" y1="0" y2="1">
              <stop
                className="[stop-color:#fff] dark:[stop-color:#34363c]"
                offset="0%"
              />
              <stop
                className="[stop-color:#eaf2f8] dark:[stop-color:#26292f]"
                offset="100%"
              />
            </linearGradient>
            <symbol id={docId} overflow="visible">
              <rect
                className="stroke-black/[0.12] dark:stroke-white/10"
                fill={`url(#${paperId})`}
                height="348.8"
                rx="19.4"
                strokeWidth="1.2"
                width="278.8"
                x="0.6"
                y="0.6"
              />
              {DOC_LINE_WIDTHS.map((width, index) => (
                <rect
                  className="fill-black/[0.12] dark:fill-white/[0.16]"
                  height="9"
                  key={width}
                  rx="4.5"
                  width={width}
                  x="30"
                  y={87 + index * 28}
                />
              ))}
            </symbol>
          </defs>
          <use
            className={cn(DOC_CLASS, DOC_REST_CLASS.left, stateClass.left)}
            href={`#${docId}`}
          />
          <use
            className={cn(DOC_CLASS, DOC_REST_CLASS.right, stateClass.right)}
            href={`#${docId}`}
          />
          <use
            className={cn(DOC_CLASS, DOC_REST_CLASS.middle, stateClass.middle)}
            href={`#${docId}`}
          />
        </svg>

        <span
          className={cn(
            FRONT_BASE_CLASS,
            open ? FRONT_OPEN_CLASS : FRONT_HOVER_CLASS
          )}
        />
      </span>
    </span>
  );
}
