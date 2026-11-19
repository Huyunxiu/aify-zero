"use client"

// Scroll area on Base UI: an overlay scrollbar that stays quiet until you reach
// for it, over shadcn's scroll-fade edge treatment. Thumb machinery adapted
// from Lina by SameerJS6 (https://lina.sameer.sh), restyled to the app tokens.
//
// Base UI keeps the scrollbar mounted while the content overflows and reports
// hover and scroll as data attributes, so visibility is a plain opacity
// transition instead of a presence animation.
//
// Touch-primary devices skip the machinery for native overflow scrolling:
// platform momentum and rubber-banding beat any custom scrollbar.

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import type { ComponentProps } from "react"

import { cn } from "@workspace/ui/lib/utils"

import { useTouchPrimary } from "../hooks/use-touch-primary"

type ScrollAreaOrientation = "vertical" | "horizontal" | "both"

const viewportClass =
  "size-full rounded-[inherit] focus-visible:outline-offset-[-1px]"

const overflowClass: Record<ScrollAreaOrientation, string> = {
  vertical: "overflow-y-auto",
  horizontal: "overflow-x-auto",
  both: "overflow-auto",
}

type ScrollAreaProps = ComponentProps<"div"> & {
  /** Which axes get a scrollbar. */
  orientation?: ScrollAreaOrientation
  /** Classes for the inner scrolling viewport, where the scroll-fade utility goes. */
  viewportClassName?: string
}

function ScrollArea({
  className,
  children,
  viewportClassName,
  orientation = "vertical",
  ...props
}: ScrollAreaProps) {
  const isTouchPrimary = useTouchPrimary()

  // Native scrolling on touch: no track to hit, no thumb to widen.
  if (isTouchPrimary) {
    return (
      <div
        data-slot="scroll-area"
        role="group"
        aria-roledescription="scroll area"
        className={cn("relative overflow-hidden", className)}
        {...props}
      >
        <div
          data-slot="scroll-area-viewport"
          tabIndex={0}
          className={cn(
            viewportClass,
            overflowClass[orientation],
            viewportClassName
          )}
        >
          {children}
        </div>
      </div>
    )
  }

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(viewportClass, viewportClassName)}
      >
        {/* Content gives Base UI an intrinsic size to measure overflow against. */}
        <ScrollAreaPrimitive.Content>{children}</ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      {orientation !== "horizontal" && <ScrollBar orientation="vertical" />}
      {orientation !== "vertical" && <ScrollBar orientation="horizontal" />}
      {orientation === "both" && <ScrollAreaPrimitive.Corner />}
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      // The 10px track is the hit target; the thumb inside rests narrow and
      // low-contrast, then widens and darkens on hover. Hiding waits out the
      // thumb shrink (160ms) before fading (120ms), so the thumb narrows back
      // first instead of the fade masking it.
      className={cn(
        "group/scrollbar absolute z-20 flex touch-none opacity-0 transition-opacity duration-120 ease-out delay-160 select-none",
        "data-hovering:opacity-100 data-scrolling:opacity-100",
        "data-hovering:duration-160 data-scrolling:duration-160",
        "data-hovering:delay-0 data-scrolling:delay-0",
        orientation === "vertical" && "inset-y-0 end-0 w-2.5",
        orientation === "horizontal" && "inset-x-0 bottom-0 h-2.5 flex-col",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className={cn(
          "relative rounded-full bg-[var(--scrollbar-thumb-color)] transition-[background-color,width,height] duration-160 ease-in-out",
          "group-hover/scrollbar:bg-[var(--scrollbar-thumb-color-hover)] active:bg-[var(--scrollbar-thumb-color-active)]",
          // The thumb sits 2px in from the container edge; the track stays
          // flush, so an edge-throw still lands on it.
          orientation === "vertical" &&
            "mx-auto my-1 w-1 -translate-x-0.5 group-hover/scrollbar:w-1.5",
          orientation === "horizontal" &&
            "mx-1 my-auto h-1 -translate-y-0.5 group-hover/scrollbar:h-1.5"
        )}
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
export type { ScrollAreaProps, ScrollAreaOrientation }
