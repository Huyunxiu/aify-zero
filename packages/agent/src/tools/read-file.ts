import { basename, dirname, join } from "node:path";

import {
  ATTACHMENT_IMAGE_TYPES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PIXELS,
  attachmentOwner,
} from "@workspace/agent-client";
import type { AttachmentRef, AttachmentRegion } from "@workspace/agent-client";
import type { Sandbox } from "@workspace/sandbox";
import { tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import {
  DECODE_MAX_BYTES,
  ImageDecodeError,
  loadImageDecoder,
  normalizeImage,
} from "../attachments/normalize";
import type { NormalizedCrop } from "../attachments/normalize";
import { readAttachment, saveAttachment } from "../attachments/store";
import type { ToolEnvironment } from "../extensions/capabilities";
import {
  acceptsInput,
  inputKindOf,
  ModelInputRefusedError,
} from "../model/input-kinds";
import {
  getFileTypeFromSandbox,
  isBinaryFile,
  toolPathDescription,
} from "../utils/fs-util";
import { imageDimensions } from "../utils/image-header";
import type { ToolOutput } from "./types";

const DEFAULT_READ_LIMIT = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`;
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;
/** The media types this tool commits; the limits come from the protocol package. */
const SUPPORTED_ATTACHMENT_MIMES = new Set<string>([
  ...ATTACHMENT_IMAGE_TYPES,
  "application/pdf",
]);

/**
 * The image formats the decoder reads and the harness stores as WebP.
 *
 * The stored form is always `image/webp`, so these are input types only: a photo from
 * a phone arrives as HEIC and leaves as WebP.
 */
const DECODABLE_IMAGE_MIMES = new Set<string>([
  ...ATTACHMENT_IMAGE_TYPES,
  "image/avif",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/bmp",
]);

/** Whether this read can decode and normalize the media type. */
function isDecodableImage(mime: string): boolean {
  return DECODABLE_IMAGE_MIMES.has(mime);
}

/**
 * How much of an image the pixel gate reads.
 *
 * A JPEG may carry a large colour profile before its frame header, and 4 KB is not
 * always enough to reach it. A read that gives up on the size also gives up on the
 * pixel limit, so it asks for more before it decides.
 */
const IMAGE_HEADER_BYTES = 256 * 1024;

const DESCRIPTION = `
Read a file or directory from the local filesystem. If the path does not exist, an error is returned.

Usage:
- Returns up to ${DEFAULT_READ_LIMIT} lines from the offset, and stops earlier when the output reaches ${MAX_BYTES_LABEL}. The result says where it stopped and which offset continues.
- The offset parameter is the line number to start from (1-indexed). An offset past the end of the file is an error.
- To read later sections, call this tool again with a larger offset.
- Use the grep tool to find specific content in large files or files with long lines.
- Contents are returned with each line prefixed by its line number as \`<line>: <content>\`. For example, if a file has contents "foo\n", you will receive "1: foo\n".
- Any line longer than ${MAX_LINE_LENGTH} characters is truncated.
- For a directory, entries come without line numbers, one per line, with a trailing \`/\` for subdirectories. Pass offset and limit to page through a large directory.
- Call this tool in parallel when you know there are multiple files you want to read.
- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.
- This tool can read image files and PDFs and return them as file attachments. Images are stored once and served from storage; the envelope reports their size, and the model only sees them when its route accepts image input.
- Large images are reduced, so small text can become unreadable. Pass region to read one part of the image at its own resolution; the envelope then names the region and its box in the source image.
`;

async function miss(
  sandbox: Sandbox,
  filepath: string
): Promise<ReadFileToolOutput> {
  const dir = dirname(filepath);
  const base = basename(filepath);
  let items: string[] = [];

  try {
    const entries = await sandbox.readdir(dir);
    items = entries
      .map((entry) => entry.name)
      .filter(
        (item) =>
          item.toLowerCase().includes(base.toLowerCase()) ||
          base.toLowerCase().includes(item.toLowerCase())
      )
      .map((item) => join(dir, item))
      .slice(0, 3);
  } catch {
    // directory read failed, no suggestions
  }

  if (items.length > 0) {
    return {
      output: `File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}`,
      code: "error",
      metadata: {
        type: "miss",
        filepath,
      },
    };
  }

  return {
    output: `File not found: ${filepath}`,
    code: "error",
    metadata: {
      type: "miss",
      filepath,
    },
  };
}

async function readDirectory(
  sandbox: Sandbox,
  filepath: string,
  offset: number,
  limit: number
): Promise<ReadFileToolOutput> {
  const dirents = await sandbox.readdir(filepath);
  // 符号链接指向目录时也带斜杠：`DirEntry` 已经把链接目标的类型算好了。
  const entries = dirents.map((dirent) =>
    dirent.isDirectory ? `${dirent.name}/` : dirent.name
  );

  entries.sort((a, b) => a.localeCompare(b));

  const start = offset - 1;
  const sliced = entries.slice(start, start + limit);
  const truncated = start + sliced.length < entries.length;

  const output = [
    `<path>${filepath}</path>`,
    "<type>directory</type>",
    "<entries>",
    sliced.join("\n"),
    truncated
      ? `\n(Showing ${sliced.length} of ${entries.length} entries. Use offset=${offset + sliced.length} to continue.)`
      : `\n(${entries.length} entries)`,
    "</entries>",
  ].join("\n");

  return {
    output,
    code: "ok",
    metadata: {
      type: "directory",
      filepath,
      truncated,
      entries: sliced,
      limit,
      offset,
      totalEntries: entries.length,
    },
  };
}

/** One human-readable byte size for the envelope. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${Math.max(1, Math.round(kib))} KB`;
  }
  return `${(kib / 1024).toFixed(1)} MB`;
}

/** The envelope every read returns, so the model reads one shape for every file. */
function attachmentEnvelope(
  filepath: string,
  mime: string,
  bytes: number,
  size: { width: number; height: number } | undefined,
  note = ""
): string {
  const kind = mime.startsWith("image/") ? "image" : "file";
  const dimensions =
    size === undefined ? "" : `, ${size.width}x${size.height} px`;
  return [
    `<path>${filepath}</path>`,
    `<type>${kind}</type>`,
    "<content>",
    `${mime}${dimensions}, ${formatBytes(bytes)}${note}`,
    "</content>",
  ].join("\n");
}

/** The advice for one axis pair: one multiplier when both axes round the same. */
function coordinateAdvice(
  source: { width: number; height: number },
  delivered: { width: number; height: number }
): string {
  const x = (source.width / delivered.width).toFixed(2);
  const y = (source.height / delivered.height).toFixed(2);
  return x === y
    ? `multiply coordinates by ${x}`
    : `multiply x coordinates by ${x} and y coordinates by ${y}`;
}

/**
 * How a reader maps a coordinate it measured on the stored copy back onto the file.
 *
 * A cropped read names the region and its source box in pixels, because the region is
 * where the detail is: a coordinate inside the copy lands inside that box. A read that
 * only reduced the whole image names the multiplier instead.
 */
function imageNote(
  image: {
    readonly originalDimensions?: {
      readonly width: number;
      readonly height: number;
    };
    readonly region?: AttachmentRegion;
    readonly cropBox?: NormalizedCrop;
  },
  delivered: { readonly width: number; readonly height: number }
): string {
  const source = image.originalDimensions;
  const box = image.cropBox;
  const { region } = image;

  if (region !== undefined && box !== undefined && source !== undefined) {
    const regionText =
      // Echoed exactly: rounding would print a region that differs from the pixel box
      // beside it, and a tiny region would round to the zero the schema refuses.
      `region ${String(region.x)},${String(region.y)},` +
      `${String(region.width)},${String(region.height)} of ` +
      `${source.width}x${source.height}`;
    const boxText =
      `source box x ${box.left}-${box.left + box.width}, ` +
      `y ${box.top}-${box.top + box.height}`;
    const reduced =
      box.width !== delivered.width || box.height !== delivered.height;
    const scale = reduced
      ? `; ${coordinateAdvice(box, delivered)}, then add the box origin (${box.left}, ${box.top})`
      : "";
    return ` (${regionText}; ${boxText}${scale})`;
  }

  if (source === undefined) {
    return "";
  }
  return ` (downscaled from ${source.width}x${source.height} px; ${coordinateAdvice(source, delivered)} to locate features in the original file)`;
}

/** What one attachment read needs. */
interface AttachmentReadInput {
  readonly sandbox: Sandbox;
  readonly filepath: string;
  readonly mime: string;
  readonly head: Uint8Array;
  /** The size the filesystem reported, when it reported one. */
  readonly bytes: number | undefined;
  readonly agentContext: ToolEnvironment;
  /** Whether the caller passed `offset` or `limit`, which do not page an attachment. */
  readonly usedTextPaging: boolean;
  /** The image region to keep; ignored for a document. */
  readonly region?: AttachmentRegion;
}

/** Append the note that a region was ignored, for a read that is not an image. */
function withIgnoredRegion<T extends { readonly output: string }>(
  result: T
): T {
  return {
    ...result,
    output: `${result.output}\n\n(region applies to images only; the whole file was read.)`,
  };
}

/** One refusal for a file this read will not commit, naming the remedy. */
function refuseAttachment(
  filepath: string,
  detail: string,
  remedy: string
): Error {
  return new Error(`cannot read "${filepath}": ${detail} ${remedy}`);
}

/**
 * The largest image the raw path stores.
 *
 * The decoded path uses the decoder's own guard instead: it works on pixels it can
 * measure, and it can shrink what is over. These are two rules for two paths, not one
 * rule written twice.
 */
/** The remedy that fits the media type: a PDF is not cropped. */
function oversizeRemedy(mime: string): string {
  return mime.startsWith("image/")
    ? "Crop or shrink the image, then read the smaller copy."
    : "Split the document, then read the smaller part.";
}

/** The declared image size, reading more of the file when the first bytes stop short. */
async function imageSize(
  sandbox: Sandbox,
  filepath: string,
  mime: string,
  head: Uint8Array
): Promise<{ width: number; height: number } | undefined> {
  if (!mime.startsWith("image/")) {
    return undefined;
  }
  const direct = imageDimensions(head);
  if (direct !== undefined || sandbox.readHead === undefined) {
    return direct;
  }
  return imageDimensions(await sandbox.readHead(filepath, IMAGE_HEADER_BYTES));
}

/**
 * Commit one image or PDF and answer with its envelope.
 *
 * The route gate runs first, because a refusal costs nothing and leaves no record.
 * An image the decoder reads is stored as a bounded WebP; without a decoder, or for a
 * PDF, the source bytes are stored as they are, inside a smaller limit.
 */
async function readAttachments(
  input: AttachmentReadInput
): Promise<ReadFileToolOutput> {
  const { filepath, mime, agentContext } = input;

  if (!acceptsInput(agentContext.inputKinds ?? ["text"], mime)) {
    throw new ModelInputRefusedError(filepath, inputKindOf(mime));
  }

  const decoder = isDecodableImage(mime) ? await loadImageDecoder() : undefined;

  if (
    decoder === undefined &&
    input.region !== undefined &&
    mime.startsWith("image/")
  ) {
    // Ignoring the region would let the model believe it looked closer than it did.
    throw refuseAttachment(
      filepath,
      "a region needs the image decoder, and this deployment has none.",
      "Read the whole image, or convert it to PNG or JPEG first."
    );
  }

  if (decoder === undefined && isDecodableImage(mime)) {
    // Without a decoder this format has no size the header can declare, so the pixel
    // limit would not hold. Refusing is the only bounded answer.
    if (!ATTACHMENT_IMAGE_TYPES.includes(mime as never)) {
      throw refuseAttachment(
        filepath,
        `${mime} needs the image decoder, and this deployment has none.`,
        "Convert it to PNG or JPEG, then read it again."
      );
    }
    return await commitRawAttachment(input);
  }

  return decoder === undefined
    ? await commitRawAttachment(input)
    : await commitNormalizedImage(input);
}

/** Store the source bytes unchanged: no decoder, or a document rather than a photo. */
async function commitRawAttachment(
  input: AttachmentReadInput
): Promise<ReadFileToolOutput> {
  const { sandbox, filepath, mime, head, bytes, agentContext } = input;

  const size = await imageSize(sandbox, filepath, mime, head);
  if (size !== undefined && size.width * size.height > ATTACHMENT_MAX_PIXELS) {
    throw refuseAttachment(
      filepath,
      `${size.width}x${size.height} px exceeds the ${ATTACHMENT_MAX_PIXELS}-pixel limit.`,
      oversizeRemedy(mime)
    );
  }
  if (bytes !== undefined && bytes > ATTACHMENT_MAX_BYTES) {
    throw refuseAttachment(
      filepath,
      `${formatBytes(bytes)} exceeds the ${formatBytes(ATTACHMENT_MAX_BYTES)} limit.`,
      oversizeRemedy(mime)
    );
  }

  const data = await sandbox.readFileBuffer(filepath);
  // A sandbox that cannot report a size is still bounded after the read: the bytes
  // never reach storage above the limit.
  if (data.byteLength > ATTACHMENT_MAX_BYTES) {
    throw refuseAttachment(
      filepath,
      `${formatBytes(data.byteLength)} exceeds the ${formatBytes(ATTACHMENT_MAX_BYTES)} limit.`,
      oversizeRemedy(mime)
    );
  }

  const attachment = await saveAttachment({
    sessionDir: agentContext.sessionDir,
    owner: attachmentOwner(agentContext.sessionId),
    data,
    mediaType: mime,
    ...(size === undefined ? {} : { width: size.width, height: size.height }),
    name: filepath,
  });

  return attachmentResult(input, attachment, data.byteLength, size);
}

/** Decode the image, store the bounded copy, and name the source size in the envelope. */
async function commitNormalizedImage(
  input: AttachmentReadInput
): Promise<ReadFileToolOutput> {
  const { sandbox, filepath, mime, bytes, agentContext } = input;

  // The decoder enforces this too. The read keeps its own check because it refuses
  // before the bytes enter memory, and the decoder's copy cannot do that.
  if (bytes !== undefined && bytes > DECODE_MAX_BYTES) {
    throw refuseAttachment(
      filepath,
      `${formatBytes(bytes)} exceeds the ${formatBytes(DECODE_MAX_BYTES)} decode limit.`,
      oversizeRemedy(mime)
    );
  }

  const data = await sandbox.readFileBuffer(filepath);
  let normalized;
  try {
    normalized = await normalizeImage(data, { region: input.region });
  } catch (error) {
    if (error instanceof ImageDecodeError) {
      throw refuseAttachment(
        filepath,
        `${error.message}.`,
        "Convert it to PNG or JPEG, then read it again."
      );
    }
    throw error;
  }

  const size = { width: normalized.width, height: normalized.height };
  const attachment = await saveAttachment({
    sessionDir: agentContext.sessionDir,
    owner: attachmentOwner(agentContext.sessionId),
    data: normalized.data,
    mediaType: normalized.mediaType,
    ...size,
    ...(normalized.originalDimensions === undefined
      ? {}
      : { originalDimensions: normalized.originalDimensions }),
    ...(normalized.region === undefined ? {} : { region: normalized.region }),
    name: filepath,
  });

  return attachmentResult(
    input,
    attachment,
    normalized.data.byteLength,
    size,
    imageNote(normalized, size),
    true
  );
}

/** The tool result for one committed attachment: envelope, metadata, and the reference. */
function attachmentResult(
  input: AttachmentReadInput,
  attachment: AttachmentRef,
  bytes: number,
  size: { width: number; height: number } | undefined,
  note?: string,
  regionApplied = false
): ReadFileToolOutput {
  const { filepath } = input;
  const envelope = attachmentEnvelope(
    filepath,
    attachment.mediaType,
    bytes,
    size,
    note
  );
  const notes = [
    input.usedTextPaging
      ? "(offset and limit apply to text files only; the whole attachment was read.)"
      : "",
    input.region === undefined || regionApplied
      ? ""
      : "(region applies to images only; the whole attachment was read.)",
  ].filter((line) => line !== "");
  const paging = notes.length === 0 ? "" : `\n\n${notes.join(" ")}`;

  return {
    output: envelope + paging,
    code: "ok",
    metadata: {
      type: "attachments",
      filepath,
      mime: attachment.mediaType,
      bytes,
      ...(size === undefined ? {} : size),
      ...(attachment.region === undefined ? {} : { region: attachment.region }),
    },
    attachments: [attachment],
  };
}

function readBinaryFile(filepath: string, mime: string): ReadFileToolOutput {
  const output = `Cannot read binary file: ${filepath}, mime: ${mime}`;
  return {
    output,
    code: "error",
    metadata: {
      type: "binary-file",
      filepath,
      mime,
    },
  };
}

/**
 * 按行切分一段文本，和 `readline` 的 `crlfDelay: Infinity` 一致：`\n`、`\r\n`
 * 和单独的 `\r` 都算行尾，结尾的换行不产生空行。
 *
 * @param text - 整份文件内容。
 * @yields 每一行的文本，不含行尾。
 */
function* splitLines(text: string): Generator<string> {
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "\n" && char !== "\r") {
      continue;
    }
    yield text.slice(start, index);
    if (char === "\r" && text[index + 1] === "\n") {
      index += 1;
    }
    start = index + 1;
  }
  if (start < text.length) {
    yield text.slice(start);
  }
}

async function readTextFile(
  sandbox: Sandbox,
  filepath: string,
  mime: string,
  offset: number,
  limit: number
): Promise<ReadFileToolOutput> {
  // 有流式能力就用它，避免大文件整份进内存；没有就退到整份读取再切行。
  const source: AsyncIterable<string> | Iterable<string> =
    sandbox.readTextStream === undefined
      ? splitLines(await sandbox.readFile(filepath))
      : sandbox.readTextStream(filepath);

  const start = offset - 1;
  const lines: string[] = [];
  let bytes = 0;
  let totalLines = 0;
  let truncatedByBytes = false;
  let hasMoreLines = false;

  for await (const rawText of source) {
    totalLines += 1;
    if (totalLines <= start) {
      continue;
    }

    if (lines.length >= limit) {
      hasMoreLines = true;
      continue;
    }

    const line =
      rawText.length > MAX_LINE_LENGTH
        ? `${rawText.slice(0, MAX_LINE_LENGTH)}${MAX_LINE_SUFFIX}`
        : rawText;
    const size = Buffer.byteLength(line, "utf-8") + (lines.length > 0 ? 1 : 0);

    if (bytes + size > MAX_BYTES) {
      truncatedByBytes = true;
      hasMoreLines = true;
      break;
    }

    lines.push(line);
    bytes += size;
  }

  if (totalLines < offset && !(totalLines === 0 && offset === 1)) {
    throw new Error(
      `Offset ${offset} is out of range for this file (${totalLines} lines)`
    );
  }

  const numbered = lines.map((line, index) => `${index + offset}: ${line}`);
  const lastReadLine = offset + lines.length - 1;
  const nextOffset = lastReadLine + 1;
  const output = [
    `<path>${filepath}</path>`,
    "<type>file</type>",
    "<content>",
    numbered.join("\n"),
    truncatedByBytes
      ? `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${offset}-${lastReadLine}. Use offset=${nextOffset} to continue.)`
      : hasMoreLines
        ? `\n\n(Showing lines ${offset}-${lastReadLine} of ${totalLines}. Use offset=${nextOffset} to continue.)`
        : `\n\n(End of file - total ${totalLines} lines)`,
    "</content>",
  ].join("\n");

  return {
    output,
    code: "ok",
    metadata: {
      type: "file",
      mime,
      text: lines.join("\n"),
      filepath,
      truncated: truncatedByBytes || hasMoreLines,
      limit,
      offset,
      totalLines,
    },
  };
}

/** The part of an image to read, as fractions of its width and height. */
const REGION_SCHEMA = z
  .object({
    x: z
      .number()
      .min(0)
      .max(1)
      .describe("Left edge, as a fraction of the width"),
    y: z
      .number()
      .min(0)
      .max(1)
      .describe("Top edge, as a fraction of the height"),
    width: z
      .number()
      .gt(0)
      .max(1)
      .describe("Region width, as a fraction of the image width"),
    height: z
      .number()
      .gt(0)
      .max(1)
      .describe("Region height, as a fraction of the image height"),
  })
  .refine((region) => region.x + region.width <= 1, {
    message: "region x + width must not exceed 1",
  })
  .refine((region) => region.y + region.height <= 1, {
    message: "region y + height must not exceed 1",
  });

const READ_TOOL_INPUT_SCHEMA = z.object({
  path: z.string().describe(toolPathDescription("file or directory to read")),
  region: REGION_SCHEMA.optional().describe(
    "Read only this part of an image, as fractions of its size. Use it after reading the whole image, to look closer at a detail without losing resolution."
  ),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("The maximum number of lines to read (defaults to 2000)"),
  offset: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("The line number to start reading from (1-indexed)"),
});

type ReadFileToolInput = z.infer<typeof READ_TOOL_INPUT_SCHEMA>;

type ReadFileToolOutputMetadata =
  | {
      type: "miss";
      filepath: string;
    }
  | {
      type: "directory";
      filepath: string;
      truncated: boolean;
      entries: string[];
      limit: number;
      offset: number;
      totalEntries: number;
    }
  | {
      type: "file";
      mime: string;
      text: string;
      filepath: string;
      truncated: boolean;
      limit: number;
      offset: number;
      totalLines?: number;
    }
  | {
      type: "attachments";
      filepath: string;
      mime: string;
      bytes?: number;
      width?: number;
      height?: number;
      region?: AttachmentRegion;
    }
  | {
      type: "binary-file";
      filepath: string;
      mime: string;
    };

type ReadFileAttachment =
  | {
      type: "file-data";
      data: string;
      mediaType: string;
      filename?: string;
    }
  | AttachmentRef;

type ReadFileToolOutput = ToolOutput<string, ReadFileToolOutputMetadata> & {
  attachments?: ReadFileAttachment[];
};

type CreateReadFileToolProps = {
  agentContext: ToolEnvironment;
};

const createReadFileTool = ({ agentContext }: CreateReadFileToolProps) =>
  tool<ReadFileToolInput, ReadFileToolOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: READ_TOOL_INPUT_SCHEMA,
    execute: async (input) => {
      const { offset, limit, region } = input;
      const { sandbox } = agentContext;
      const filepath = sandbox.resolvePath(input.path);

      const normalizedOffset = offset ?? 1;
      const normalizedLimit = limit ?? DEFAULT_READ_LIMIT;

      let stats;
      try {
        stats = await sandbox.stat(filepath);
      } catch {
        return await miss(sandbox, filepath);
      }

      if (stats.isDirectory) {
        const listed = await readDirectory(
          sandbox,
          filepath,
          normalizedOffset,
          normalizedLimit
        );
        return region === undefined ? listed : withIgnoredRegion(listed);
      }

      // 既不是文件也不是目录：坏符号链接、socket、设备节点。旧实现靠 `stat`
      // 抛 ENOENT 走进 miss()，现在 `stat` 对坏链接会如实回报链接本身，所以要
      // 在这里显式挡一次，否则会继续去读一个读不出来的目标。
      if (!stats.isFile) {
        return await miss(sandbox, filepath);
      }

      // 只读开头一段做类型嗅探：整份读进来对二进制大文件是不可接受的。
      const [mime, ext, sample] = await getFileTypeFromSandbox(
        sandbox,
        filepath
      );

      // A decodable image reaches the attachment branch even when the harness would
      // not store its source format: the stored form is a normalized WebP.
      if (
        stats.isFile &&
        mime &&
        (SUPPORTED_ATTACHMENT_MIMES.has(mime) || isDecodableImage(mime))
      ) {
        return await readAttachments({
          sandbox,
          filepath,
          mime,
          head: sample,
          bytes: stats.size,
          agentContext,
          usedTextPaging: offset !== undefined || limit !== undefined,
          ...(region === undefined ? {} : { region }),
        });
      }

      if (stats.isFile && ext && isBinaryFile(ext, sample)) {
        return readBinaryFile(filepath, mime);
      }

      const read = await readTextFile(
        sandbox,
        filepath,
        mime,
        normalizedOffset,
        normalizedLimit
      );
      return region === undefined ? read : withIgnoredRegion(read);
    },
    async toModelOutput({ output }: { output: ReadFileToolOutput }): Promise<
      | { type: "error-text"; value: string }
      | { type: "text"; value: string }
      | {
          type: "content";
          value: (
            | { type: "text"; text: string }
            | {
                type: "file";
                data: { type: "data"; data: string };
                mediaType: string;
                filename?: string;
              }
          )[];
        }
    > {
      if (output.code === "error") {
        return {
          type: "error-text",
          value: output.output,
        };
      }

      const items = output.attachments ?? [];
      if (items.length === 0) {
        return {
          type: "text",
          value: output.output,
        };
      }

      // The envelope carries the path and the size; the files carry the pixels. A
      // model that receives only the files cannot say where they came from.
      const files = await Promise.all(
        items.map(async (item) =>
          item.type === "file-data"
            ? {
                type: "file" as const,
                data: { type: "data" as const, data: item.data },
                mediaType: item.mediaType,
                ...(item.filename === undefined
                  ? {}
                  : { filename: item.filename }),
              }
            : {
                type: "file" as const,
                data: {
                  type: "data" as const,
                  data: Buffer.from(
                    await readAttachment(agentContext.sessionDir, item)
                  ).toString("base64"),
                },
                mediaType: item.mediaType,
                ...(item.name === undefined ? {} : { filename: item.name }),
              }
        )
      );

      return {
        type: "content",
        value: [{ type: "text", text: output.output }, ...files],
      };
    },
  });

type ReadFileToolType = ReturnType<typeof createReadFileTool>;

export { createReadFileTool, type ReadFileToolType };
