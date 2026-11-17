import { startFakeProvider } from "./index.js";

const argv = process.argv.slice(2);

const valueOf = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const has = (name: string): boolean => argv.includes(`--${name}`);

/** `--header authorization=Bearer x` 可以写多次。 */
const headers = (): Record<string, string> => {
  const collected: Record<string, string> = {};
  for (const [index, arg] of argv.entries()) {
    if (arg !== "--header") {
      continue;
    }

    const pair = argv[index + 1] ?? "";
    const separator = pair.indexOf("=");
    if (separator > 0) {
      collected[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
  }

  return collected;
};

const scenario = valueOf("scenario");
const recordUrl = valueOf("record");
const out = valueOf("out");
const tapeOut = valueOf("tape");
const playPath = valueOf("play");
const port = Number(valueOf("port") ?? 0);

// 录制带只在代理模式里有内容：没有上游，就没有帧可记。
if (tapeOut !== undefined && recordUrl === undefined) {
  process.stderr.write("[fake] --tape needs --record\n");
  process.exit(1);
}

// 一个回放，一个录制，不能同时开。
if (playPath !== undefined && recordUrl !== undefined) {
  process.stderr.write("[fake] use either --play or --record\n");
  process.exit(1);
}

// 同时给 `--tape` 与 `--record` 时默认不写旧格式；要两份就显式给 `--out`。
const legacyOut =
  out ??
  (tapeOut === undefined && recordUrl !== undefined
    ? "packages/agent/scenarios/recorded/recording.json"
    : undefined);

const provider = await startFakeProvider({
  ...(scenario ? { scenario } : {}),
  ...(recordUrl
    ? {
        record: {
          url: recordUrl,
          ...(legacyOut === undefined ? {} : { out: legacyOut }),
          append: has("append"),
          headers: headers(),
        },
      }
    : {}),
  ...(tapeOut === undefined
    ? {}
    : { tape: { out: tapeOut, redact: has("redact") } }),
  ...(playPath === undefined
    ? {}
    : {
        play: {
          path: playPath,
          ...(valueOf("speed") === undefined
            ? {}
            : { speed: Number(valueOf("speed")) }),
          ...(valueOf("pause-at") === undefined
            ? {}
            : { pauseAt: Number(valueOf("pause-at")) }),
        },
      }),
  port,
  log: (message) => {
    process.stdout.write(`[fake] ${message}\n`);
  },
});

const parts = [`[fake-provider] baseURL=${provider.baseURL}`];
if (scenario) {
  parts.push(`scenario=${scenario}`);
}
if (recordUrl) {
  parts.push(`recording ${recordUrl} -> ${legacyOut ?? "(tape only)"}`);
}
if (tapeOut !== undefined) {
  parts.push(`tape -> ${tapeOut}${has("redact") ? " (redacted)" : ""}`);
}
if (playPath !== undefined) {
  const pauseAt = valueOf("pause-at");
  parts.push(
    `playing ${playPath}${pauseAt === undefined ? "" : ` (pause at frame ${pauseAt})`}`
  );
}
process.stdout.write(`${parts.join("  ")}\n`);

const stop = async (): Promise<void> => {
  await provider.close();
  process.exit(0);
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
