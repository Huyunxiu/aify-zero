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
const port = Number(valueOf("port") ?? 0);

const provider = await startFakeProvider({
  ...(scenario ? { scenario } : {}),
  ...(recordUrl
    ? {
        record: {
          url: recordUrl,
          out: out ?? "packages/agent/scenarios/recorded/recording.json",
          append: has("append"),
          headers: headers(),
        },
      }
    : {}),
  port,
});

const parts = [`[fake-provider] baseURL=${provider.baseURL}`];
if (scenario) {
  parts.push(`scenario=${scenario}`);
}
if (recordUrl) {
  parts.push(
    `recording ${recordUrl} -> ${out ?? "scenarios/recorded/recording.json"}`
  );
}
process.stdout.write(`${parts.join("  ")}\n`);

const stop = async (): Promise<void> => {
  await provider.close();
  process.exit(0);
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
