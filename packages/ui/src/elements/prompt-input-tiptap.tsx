import type { JSONContent } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { Placeholder } from "@tiptap/extensions";
import {
  EditorContent,
  mergeAttributes,
  nodePasteRule,
  ReactRenderer,
  useEditor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import "./prompt-input.tiptap.css";
import { renderToReactElement } from "@tiptap/static-renderer";
import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from "@tiptap/suggestion";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  DropdownMenuGroup,
  DropdownMenuLabel,
} from "../components/dropdown-menu";
import type { client } from "../lib/orpc";
import { cn } from "../lib/utils";
import {
  useOptionalPromptInputController,
  usePromptInputAttachments,
} from "./prompt-input";

type SuggestionType = {
  id: string;
  label: string;
  type: "skill" | "command" | "file";
};

type MentionTagConfig = {
  /** XML tag name serialized into the plain text, e.g. "skill" */
  tag: string;
  /** Sticky pattern matching one serialized tag at the current cursor position */
  pattern: RegExp;
  /** Build mention attrs from a match; parse tag contents here if needed */
  toAttrs: (match: RegExpExecArray) => Record<string, unknown>;
};

/** Extract the name attribute from a serialized tag, e.g. `<skill name="x" />` -> "x" */
const extractNameAttr = (xml: string) => /name="([^"]+)"/.exec(xml)?.[1] ?? "";

/**
 * Registry of XML tags that serialize as mention nodes. renderText embeds
 * attrs.id (the raw XML) into the plain text; entries here parse it back.
 * Patterns only match the tag itself, not its contents. Add a new entry
 * (e.g. command/resource) to support more mention types. Entries are tried
 * in order, so the first match at a position wins.
 */
const MENTION_TAG_CONFIGS: MentionTagConfig[] = [
  {
    tag: "skill",
    pattern: /<skill\s[^>]*\/>/y,
    toAttrs: (match) => ({
      id: match[0],
      label: `skill:${extractNameAttr(match[0])}`,
    }),
  },
];

/**
 * Rebuild a Tiptap doc from serialized plain text. Mention nodes are embedded
 * in the text as XML tags (see MENTION_TAG_CONFIGS), so a scan restores them;
 * everything else stays plain text. Each newline starts a new paragraph, and
 * a blank line (two consecutive newlines) adds an empty paragraph.
 */
export const textToJSONContent = (text: string): JSONContent => {
  // Mention tags are single-line, so scanning each line independently is
  // equivalent to scanning the whole text.
  const parseLine = (line: string): JSONContent[] => {
    const content: JSONContent[] = [];
    let cursor = 0;
    let textStart = 0;

    const pushText = (end: number) => {
      if (end > textStart) {
        content.push({ type: "text", text: line.slice(textStart, end) });
      }
    };

    while (cursor < line.length) {
      let matched = false;

      for (const config of MENTION_TAG_CONFIGS) {
        config.pattern.lastIndex = cursor;
        const match = config.pattern.exec(line);

        if (match) {
          pushText(cursor);
          content.push({
            type: "mention",
            attrs: { mentionSuggestionChar: "/", ...config.toAttrs(match) },
          });
          cursor = config.pattern.lastIndex;
          textStart = cursor;
          matched = true;
          break;
        }
      }

      if (!matched) {
        cursor++;
      }
    }

    pushText(line.length);

    return content;
  };

  const paragraphs = text.split("\n");
  const content: JSONContent[] = [];
  let prevParagraph = undefined;
  for (const currParagraph of paragraphs) {
    if (currParagraph) {
      content.push({
        type: "paragraph",
        content: parseLine(currParagraph),
      });
    } else if (!prevParagraph) {
      content.push({
        type: "paragraph",
      });
      // content.at(-1)?.content?.push({ type: "hardBreak" });
    }
    prevParagraph = currParagraph;
  }

  return { type: "doc", content };
};

const MentionDropdown = forwardRef(
  (
    props: SuggestionProps<SessionResourcesType["skills"][0], SuggestionType>,
    ref
  ) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    const selectItem = (index: number) => {
      const item = props.items[index];

      if (item) {
        const skillXML = `<skill name="${item.name}" path="${item.location}" />`;
        props.command({
          id: skillXML,
          label: `skill:${item.name}`,
          type: "skill",
        });
      }
    };

    const upHandler = () => {
      setSelectedIndex(
        (selectedIndex + props.items.length - 1) % props.items.length
      );
    };

    const downHandler = () => {
      setSelectedIndex((selectedIndex + 1) % props.items.length);
    };

    const enterHandler = () => {
      selectItem(selectedIndex);
    };

    useEffect(() => {
      setSelectedIndex(0);
    }, [props.items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === "ArrowUp") {
          upHandler();
          return true;
        }

        if (event.key === "ArrowDown") {
          downHandler();
          return true;
        }

        if (event.key === "Enter") {
          enterHandler();
          return true;
        }

        return false;
      },
    }));

    return (
      <div className="z-50 max-h-(--available-height) w-72 min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal">Skill</DropdownMenuLabel>
          {props.items.length
            ? props.items.map((item, index) => (
                <div
                  data-slot="dropdown-menu-item"
                  className={cn(
                    "group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
                    {
                      "bg-accent text-accent-foreground":
                        index === selectedIndex,
                    }
                  )}
                  key={index}
                  onClick={() => {
                    selectItem(index);
                  }}
                >
                  {item.name}
                </div>
              ))
            : null}
        </DropdownMenuGroup>
      </div>
    );
  }
);

type SessionResourcesType = NonNullable<
  Awaited<ReturnType<typeof client.session.listSessionResources>>
>;

const PromptMention = Mention.extend({
  addPasteRules() {
    return [
      nodePasteRule({
        // Rebuild skill mentions from serialized XML tags pasted as plain
        // text, e.g. `<skill name="language" path="/path/to/SKILL.md" />`.
        // Keep the raw XML as attrs.id so copying the mention serializes back
        // to the same tag (see renderText and MENTION_TAG_CONFIGS).
        find: /<skill\s[^>]*\/>/g,
        type: this.type,
        getAttributes: (match) => {
          const skillXML = match[0];
          return {
            id: skillXML,
            label: `skill:${extractNameAttr(skillXML)}`,
            type: "skill",
            mentionSuggestionChar: "/",
          };
        },
      }),
    ];
  },
});

const TIPTAP_EXTENSION_FOR_STATIC_RENDER = [
  StarterKit.configure({
    blockquote: false,
    bulletList: false,
    codeBlock: false,
    hardBreak: { keepMarks: true },
    heading: false,
    horizontalRule: false,
    listItem: false,
    orderedList: false,
    bold: false,
    code: false,
    italic: false,
    link: false,
    strike: false,
    underline: false,
    listKeymap: false,
    trailingNode: false,
  }),
  PromptMention.configure({
    HTMLAttributes: {
      class: "mention",
    },
    deleteTriggerWithBackspace: true,
    renderHTML({ options, node }) {
      return [
        "span",
        mergeAttributes(options.HTMLAttributes, {
          class: "mention mention-skill",
        }),
        `${node.attrs.mentionSuggestionChar}${node.attrs.label}`,
      ];
    },
    renderText({ node }) {
      return node.attrs.id as string;
    },
    suggestions: [
      {
        char: "/",
        placement: "top-start",
        offset: { mainAxis: 8 },
      },
    ],
  }),
];

export const renderTextToReactElement = (text: string) => {
  const jsonContent = textToJSONContent(text);
  return renderToReactElement({
    content: jsonContent,
    extensions: TIPTAP_EXTENSION_FOR_STATIC_RENDER,
  });
};

export type PromptInputTiptapProps = {
  placeholder?: string;
  onEmptyChange?: (isEmpty: boolean) => void;
  resources?: SessionResourcesType;
};

export const PromptInputTiptap = ({
  placeholder = "What would you like to know?",
  onEmptyChange,
  resources,
}: PromptInputTiptapProps) => {
  const controller = useOptionalPromptInputController();
  const attachments = usePromptInputAttachments();
  const [isComposing, setIsComposing] = useState(false);
  const mentionStateRef = useRef(false);
  const resourcesRef = useRef(resources);
  const textValueRef = useRef("");
  const editorRef = controller?.editorRef;

  useEffect(() => {
    resourcesRef.current = resources;
  }, [resources]);

  const extensions = [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      hardBreak: { keepMarks: true },
      heading: false,
      horizontalRule: false,
      listItem: false,
      orderedList: false,
      bold: false,
      code: false,
      italic: false,
      link: false,
      strike: false,
      underline: false,
      listKeymap: false,
      trailingNode: false,
    }),
    Placeholder.configure({
      placeholder,
    }),
    PromptMention.configure({
      HTMLAttributes: {
        class: "mention",
      },
      deleteTriggerWithBackspace: true,
      renderHTML({ options, node }) {
        return [
          "span",
          mergeAttributes(options.HTMLAttributes, {
            class: "mention mention-skill",
          }),
          `${node.attrs.mentionSuggestionChar}${node.attrs.label}`,
        ];
      },
      renderText({ node }) {
        return node.attrs.id as string;
      },
      suggestions: [
        {
          char: "/",
          placement: "top-start",
          offset: { mainAxis: 8 },
          initialItems: resourcesRef.current?.skills,
          items: ({ query }) => {
            if (!resourcesRef.current?.skills) {
              return [];
            }
            const keyword = query.toLowerCase();
            return resourcesRef.current?.skills.filter((e) =>
              e.name.toLowerCase().includes(keyword)
            );
          },
          render: () => {
            let component: ReactRenderer<unknown, any>;
            let unmount: (() => void) | null = null;

            return {
              onStart(props: SuggestionProps<string, SuggestionType>) {
                component = new ReactRenderer(MentionDropdown, {
                  props,
                  editor: props.editor,
                });

                // The plugin mounts the element, positions it, and keeps it anchored.
                unmount = props.mount(component.element);
                mentionStateRef.current = true;
              },
              onUpdate(props: SuggestionProps<string, SuggestionType>) {
                component.updateProps(props);
              },
              onKeyDown(props: SuggestionKeyDownProps) {
                if (props.event.key === "Escape") {
                  component.destroy();
                  return true;
                }
                const handlers = component.ref as {
                  onKeyDown?: (props: SuggestionKeyDownProps) => boolean;
                };
                return handlers.onKeyDown?.(props) ?? false;
              },
              onExit() {
                unmount?.();
                component.destroy();
                mentionStateRef.current = false;
              },
            };
          },
        },
      ],
    }),
  ];

  const editor = useEditor({
    enablePasteRules: true,
    enableInputRules: true,
    extensions,
    editorProps: {
      handleKeyDown: (_, event) => handleKeyDown(event),
      attributes: {
        "data-slot": "input-group-control",
        class:
          "w-full outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 disabled:bg-transparent aria-invalid:ring-0 dark:bg-transparent dark:disabled:bg-transparent",
      },
    },
    content: controller?.textInput.value ?? "",
    onUpdate: ({ editor: currentEditor }) => {
      onEmptyChange?.(currentEditor.isEmpty);
      textValueRef.current = currentEditor.getText();
      controller?.textInput.setInput(textValueRef.current);
    },
  });

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // If the external handler prevented default, don't run internal logic
      if (e.defaultPrevented) {
        return;
      }

      if (mentionStateRef.current) {
        return;
      }

      if (e.key === "Enter") {
        if (isComposing || e.isComposing) {
          return;
        }
        if (e.shiftKey) {
          return;
        }
        e.preventDefault();

        // Check if the submit button is disabled before submitting
        const form = controller?.formRef.current;
        const submitButton = form?.querySelector(
          'button[type="submit"]'
        ) as HTMLButtonElement | null;
        if (submitButton?.disabled) {
          return;
        }

        form?.requestSubmit();
      }

      // Remove last attachment when Backspace is pressed and textarea is empty
      if (
        e.key === "Backspace" &&
        textValueRef.current === "" &&
        attachments.files.length > 0
      ) {
        e.preventDefault();
        const lastAttachment = attachments.files.at(-1);
        if (lastAttachment) {
          attachments.remove(lastAttachment.id);
        }
        return true;
      }
    },
    [isComposing, attachments, controller?.formRef]
  );

  // Sync editor instance out to parent via editorRef, and report initial empty state
  useEffect(() => {
    if (editorRef) {
      editorRef.current = editor;
    }
  }, [editor, editorRef]);

  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false);
  }, []);
  const handleCompositionStart = useCallback(() => {
    setIsComposing(true);
  }, []);

  return (
    <EditorContent
      name="message"
      onCompositionEnd={handleCompositionEnd}
      onCompositionStart={handleCompositionStart}
      className="flex w-full border-input px-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 flex-1 resize-none rounded-none border-0 bg-transparent py-2 shadow-none ring-0 focus-visible:ring-0 disabled:bg-transparent aria-invalid:ring-0 dark:bg-transparent dark:disabled:bg-transparent field-sizing-content max-h-48 min-h-16 overflow-scroll"
      editor={editor}
    />
  );
};
