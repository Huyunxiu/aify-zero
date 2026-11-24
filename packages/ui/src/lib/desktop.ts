/**
 * Whether the UI renders inside the Electron desktop shell.
 *
 * The preload script injects `aifyDesktop` synchronously; browser sessions omit it.
 */
export const isDesktopShell =
  typeof window !== "undefined" && window.aifyDesktop !== undefined;

/**
 * Open a local path in the OS file manager inside Desktop, or copy it to the
 * clipboard in Web environments.
 */
export async function openLocalPath(
  targetPath: string
): Promise<"opened" | "copied"> {
  if (typeof window !== "undefined" && window.aifyDesktop?.openPath) {
    try {
      const errorMessage = await window.aifyDesktop.openPath(targetPath);
      if (errorMessage === "") {
        return "opened";
      }
    } catch {
      // Fall back to copying the path when OS open fails.
    }
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(targetPath);
  }
  return "copied";
}
