import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import type { MotionValue } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "../hover-card";

type Side = "left" | "right";
type SectionKind = "title" | "subtitle" | "section" | "body";
type SectionLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type ProximitySection = {
  id: string;
  label: string;
  kind?: SectionKind;
  level?: SectionLevel;
};

/**
 * 一条横线的长短，用占可见宽度的比例表示。
 *
 * 这样各层级的相对长短是跟着 `dashWidth` 走的，改宽度不用重新配一套数值。
 */
type DashPreset = {
  /** 静止时的长度比例。 */
  base: number;
  /** 指针落在这一条上时的长度比例。 */
  active: number;
  thickness: number;
  className: string;
};

type DashProps = {
  active: boolean;
  dashWidth: number;
  mouseY: MotionValue<number>;
  onSelect: (id: string) => void;
  registerDash: (id: string, node: HTMLButtonElement | null) => void;
  section: ProximitySection;
  sectionKind: SectionKind;
  side: Side;
};

type ProximitySidebarProps = {
  /**
   * 当前所在的小节。传入后由使用方决定标记位置，组件不再读 DOM 自己推断；
   * 适合位置来自滚动容器（例如 MessageScroller 的锚点）而不是元素坐标的页面。
   */
  activeId?: string;
  activeOffset?: number;
  className?: string;
  /**
   * 一条小节横线的宽度（px）。整条栏的宽度由它加上两侧的 `mx-4` 决定，
   * 使用方为侧栏留出的列宽要跟着它走。
   */
  dashWidth?: number;
  /** 导航的读屏名字。 */
  label?: string;
  /** 点一个小节时调用。不传就按 id 滚动到页面上的元素。 */
  onSelect?: (id: string) => void;
  sections: ProximitySection[];
  side?: Side;
};

const RADIUS = 40;
const DEFAULT_DASH_WIDTH = 110;
const PULSE_RESET_DELAY = 80;

const DASH_PRESETS: Record<SectionKind, DashPreset> = {
  title: {
    base: 0.12,
    active: 0.18,
    thickness: 2,
    className: "bg-foreground/40",
  },
  subtitle: {
    base: 0.33,
    active: 0.66,
    thickness: 3,
    className: "bg-foreground/35",
  },
  section: {
    base: 0.27,
    active: 0.54,
    thickness: 3,
    className: "bg-muted-foreground/40",
  },
  body: {
    base: 0.22,
    active: 0.44,
    thickness: 3,
    className: "bg-muted-foreground/40",
  },
};

const getSectionElement = (id: string) =>
  typeof document === "undefined"
    ? null
    : document.querySelector<HTMLElement>(`#${id}`);

const getSectionKind = (section: ProximitySection): SectionKind => {
  if (section.kind) {
    return section.kind;
  }
  if (section.level === 1) {
    return "title";
  }
  if (section.level === 2) {
    return "subtitle";
  }
  if (section.level === 3) {
    return "section";
  }
  return "body";
};

const getElementSectionKind = (id: string): SectionKind | undefined => {
  const heading = getSectionElement(id)?.querySelector(
    "h1, h2, h3, h4, h5, h6"
  );
  const tagName = heading?.tagName.toLowerCase();

  if (tagName === "h1") {
    return "title";
  }
  if (tagName === "h2") {
    return "subtitle";
  }
  if (tagName === "h3") {
    return "section";
  }
  if (tagName) {
    return "body";
  }
};

const getScrollParent = (element: HTMLElement) => {
  let parent = element.parentElement;

  while (parent) {
    const { overflowY } = window.getComputedStyle(parent);

    if (/(auto|scroll|overlay)/.test(overflowY)) {
      return parent;
    }

    parent = parent.parentElement;
  }

  return window;
};

const Dash = ({
  active,
  dashWidth,
  mouseY,
  onSelect,
  registerDash,
  section,
  sectionKind,
  side,
}: DashProps) => {
  const ref = useRef<HTMLButtonElement>(null);
  const preset = DASH_PRESETS[sectionKind];

  useEffect(() => {
    registerDash(section.id, ref.current);
    return () => registerDash(section.id, null);
  }, [registerDash, section.id]);

  const distance = useTransform(mouseY, (y) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) {
      return RADIUS;
    }
    return y - (rect.top + rect.height / 2);
  });

  const targetWidthRatio = useTransform(
    distance,
    [-RADIUS, 0, RADIUS],
    [preset.base, preset.active, preset.base],
    { clamp: true }
  );

  const widthRatio = useSpring(targetWidthRatio, {
    // 刚度：弹簧把当前值拉回目标值的力度。越大越紧跟指针，手感越“硬”。
    stiffness: 320,
    // 阻尼：抵消回弹的摩擦力。越大越不易越过目标值，过大则显得拖沓。
    damping: 34,
    // 质量：惯性大小。越大起步和换向越慢，与刚度一起决定固有频率（ω = √(k/m)）。
    mass: 0.7,
  });

  /**
   * 动画宽度而不是 `scaleX`：非等比缩放会把 `rounded-full` 的圆角一起横向压扁，
   * 横线末端看上去就成了直角切边。
   */
  const width = useTransform(widthRatio, (ratio) => `${ratio * 100}%`);

  return (
    <HoverCard>
      <HoverCardTrigger
        closeDelay={100}
        delay={150}
        render={
          <button
            ref={ref}
            type="button"
            aria-current={active ? "location" : undefined}
            aria-label={`Go to ${section.label}`}
            className="group relative flex h-px items-center border-0 bg-transparent p-0 outline-none before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']"
            style={{ width: dashWidth }}
            onClick={() => onSelect(section.id)}
          />
        }
      >
        <motion.span
          className={`block rounded-full transition-colors duration-150 ease-out group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 ${
            active
              ? "bg-foreground"
              : `${preset.className} group-hover:bg-foreground/70`
          }`}
          style={{
            height: preset.thickness,
            marginInlineStart: side === "right" ? "auto" : undefined,
            width,
          }}
        />
      </HoverCardTrigger>
      <HoverCardContent
        align="center"
        alignOffset={0}
        className="w-64 shadow-sm border-none"
        side={side === "right" ? "left" : "right"}
        sideOffset={-80}
      >
        <p className="line-clamp-4">{section.label}</p>
      </HoverCardContent>
    </HoverCard>
  );
};

const ProximitySidebar = ({
  activeId: controlledActiveId,
  activeOffset = 0.4,
  className = "",
  dashWidth = DEFAULT_DASH_WIDTH,
  label = "Page sections",
  onSelect,
  side = "left",
  sections,
}: ProximitySidebarProps) => {
  const mouseY = useMotionValue(Infinity);
  const shouldReduceMotion = useReducedMotion();
  const dashRefs = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const pointerInside = useRef(false);
  const resetTimer = useRef<number | null>(null);
  const [localActiveId, setLocalActiveId] = useState(sections[0]?.id);
  const [detectedKinds, setDetectedKinds] = useState<
    Record<string, SectionKind>
  >({});

  const activeId = controlledActiveId ?? localActiveId;

  const sectionIds = useMemo(
    () => sections.map((section) => section.id).join("|"),
    [sections]
  );

  const registerDash = useCallback(
    (id: string, node: HTMLButtonElement | null) => {
      if (node) {
        dashRefs.current.set(id, node);
        return;
      }

      dashRefs.current.delete(id);
    },
    []
  );

  const clearPendingReset = useCallback(() => {
    if (!resetTimer.current) {
      return;
    }

    window.clearTimeout(resetTimer.current);
    resetTimer.current = null;
  }, []);

  const setMouseToDash = useCallback(
    (id?: string) => {
      if (!id) {
        mouseY.set(Infinity);
        return;
      }

      const node = dashRefs.current.get(id);
      if (!node) {
        return;
      }

      const rect = node.getBoundingClientRect();
      mouseY.set(rect.top + rect.height / 2);
    },
    [mouseY]
  );

  const pulseDash = useCallback(
    (id?: string) => {
      setMouseToDash(id);
      clearPendingReset();

      if (!id || pointerInside.current) {
        return;
      }

      resetTimer.current = window.setTimeout(() => {
        mouseY.set(Infinity);
        resetTimer.current = null;
      }, PULSE_RESET_DELAY);
    },
    [clearPendingReset, mouseY, setMouseToDash]
  );

  const selectSection = useCallback(
    (id: string) => {
      // 使用方知道怎么跳（例如聊天记录要滚到某条消息），把跳转交回去；
      // 组件只负责给出即时的标记反馈。
      if (onSelect) {
        onSelect(id);
        if (controlledActiveId === undefined) {
          setLocalActiveId(id);
        }
        pulseDash(id);
        return;
      }

      const element = getSectionElement(id);
      if (!element) {
        return;
      }

      element.scrollIntoView({
        behavior: shouldReduceMotion ? "auto" : "smooth",
        block: "start",
      });

      window.history.replaceState(null, "", `#${id}`);
      setLocalActiveId(id);
      pulseDash(id);
    },
    [controlledActiveId, onSelect, pulseDash, shouldReduceMotion]
  );

  useEffect(() => () => clearPendingReset(), [clearPendingReset]);

  // 条目多于窗口高度时列表会自己滚；让活动条目留在列表视野里，
  // 但只滚列表，不滚整个页面。
  useEffect(() => {
    const list = listRef.current;
    const dash = activeId ? dashRefs.current.get(activeId) : undefined;
    if (!list || !dash) {
      return;
    }

    const listRect = list.getBoundingClientRect();
    const dashRect = dash.getBoundingClientRect();

    if (dashRect.top < listRect.top) {
      list.scrollTop -= listRect.top - dashRect.top;
    } else if (dashRect.bottom > listRect.bottom) {
      list.scrollTop += dashRect.bottom - listRect.bottom;
    }
  }, [activeId, sectionIds]);

  useEffect(() => {
    const kinds: Record<string, SectionKind> = {};

    for (const section of sections) {
      kinds[section.id] =
        section.kind || section.level
          ? getSectionKind(section)
          : (getElementSectionKind(section.id) ?? getSectionKind(section));
    }

    setDetectedKinds(kinds);
  }, [sectionIds, sections]);

  useEffect(() => {
    if (!sections.length) {
      return;
    }

    // 受控时不再按 DOM 坐标推断活动小节：使用方的滚动容器才是位置的来源，
    // 两套推断同时写入会互相覆盖。
    if (controlledActiveId !== undefined) {
      return;
    }

    let frame = 0;

    const updateActiveSection = () => {
      frame = 0;

      const anchorY = window.innerHeight * activeOffset;
      let nextActiveId = sections[0]?.id;
      let shortestDistance = Number.POSITIVE_INFINITY;

      for (const section of sections) {
        const element = getSectionElement(section.id);
        if (!element) {
          continue;
        }

        const rect = element.getBoundingClientRect();
        const containsAnchor = rect.top <= anchorY && rect.bottom >= anchorY;
        const distance = containsAnchor
          ? 0
          : Math.min(
              Math.abs(rect.top - anchorY),
              Math.abs(rect.bottom - anchorY)
            );

        if (distance < shortestDistance) {
          shortestDistance = distance;
          nextActiveId = section.id;
        }
      }

      setLocalActiveId(nextActiveId);
    };

    const scheduleUpdate = () => {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(updateActiveSection);
    };

    const scrollParents = new Set<EventTarget>([window]);

    for (const section of sections) {
      const element = getSectionElement(section.id);
      if (element) {
        scrollParents.add(getScrollParent(element));
      }
    }

    updateActiveSection();

    for (const parent of scrollParents) {
      parent.addEventListener("scroll", scheduleUpdate, { passive: true });
    }

    window.addEventListener("resize", scheduleUpdate);

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }

      for (const parent of scrollParents) {
        parent.removeEventListener("scroll", scheduleUpdate);
      }

      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [activeOffset, controlledActiveId, sectionIds, sections]);

  return (
    <nav
      aria-label={label}
      className={`flex h-full min-h-0 items-center ${
        side === "left" ? "justify-start" : "justify-end"
      } ${className}`}
    >
      <div
        ref={listRef}
        className={`new-home_minimap__dDggR mx-4 flex max-h-full flex-col overscroll-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
          side === "right" ? "items-end" : "items-start"
        }`}
        data-proximity-list=""
        style={{ gap: 8 }}
        onPointerMove={(event) => {
          clearPendingReset();
          pointerInside.current = true;
          mouseY.set(event.clientY);
        }}
        onPointerLeave={() => {
          pointerInside.current = false;
          mouseY.set(Infinity);
        }}
      >
        {sections.map((section) => (
          <Dash
            key={section.id}
            // 活动条目只换颜色，长度归指针管：滚到哪一节都不会让它变长。
            active={section.id === activeId}
            dashWidth={dashWidth}
            mouseY={mouseY}
            onSelect={selectSection}
            registerDash={registerDash}
            section={section}
            sectionKind={detectedKinds[section.id] ?? getSectionKind(section)}
            side={side}
          />
        ))}
      </div>
    </nav>
  );
};

export default ProximitySidebar;
