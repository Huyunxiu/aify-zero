import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Runs a tool and returns its output, or an empty string when it fails. */
const read = (command: string, args: readonly string[]): string => {
  try {
    return execFileSync(command, args, { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
};

/** Runs a tool and waits for it. */
const run = (command: string, args: readonly string[]): void => {
  execFileSync(command, args, { stdio: "ignore" });
};

/** The product name that the desktop package declares. */
const productNameOf = (): string => {
  const file = path.join(ROOT, "apps/desktop/package.json");
  const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
  const name =
    typeof parsed === "object" && parsed !== null && "productName" in parsed
      ? parsed.productName
      : undefined;

  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`apps/desktop/package.json needs a productName`);
  }

  return name;
};

/**
 * Gives the development bundle the name of the product.
 *
 * In development the running bundle is `node_modules/electron/dist/Electron.app`, and the
 * Dock reads the display name of that bundle, so the tooltip says "Electron".
 * `app.setName()` does not help: macOS reads the bundle, not the process.
 *
 * This edit invalidates the code signature, so the caller runs it before
 * `ensureElectronSignature()`. A reinstall brings back the original bundle, and `preStart`
 * repairs it again on the next start.
 *
 * @returns Whether the bundle changed.
 */
export const ensureElectronAppName = (): boolean => {
  if (process.platform !== "darwin") {
    return false;
  }

  const require = createRequire(import.meta.url);
  // In Node the default export of the `electron` package is the path of its binary.
  const bundle = path.join(require("electron") as string, "../../..");
  const plist = path.join(bundle, "Contents/Info.plist");
  const productName = productNameOf();

  if (
    read("plutil", [
      "-extract",
      "CFBundleDisplayName",
      "raw",
      "-o",
      "-",
      plist,
    ]) === productName
  ) {
    return false;
  }

  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    run("plutil", ["-replace", key, "-string", productName, plist]);
  }

  console.log(`[dev] renamed the Electron bundle to "${productName}"`);

  return true;
};
