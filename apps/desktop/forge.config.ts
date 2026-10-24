import { existsSync } from "node:fs";
import { chmod, cp, mkdir } from "node:fs/promises";
import path from "node:path";

import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { rgPath } from "@vscode/ripgrep";

// Stages the ripgrep binary into resources/, which packagerConfig.extraResource
// carries into the app. The binary can neither be inlined into the JS bundle
// nor be executed from inside app.asar, so it has to be a real file next to the
// app. Running this before start and before package keeps dev and packaged
// builds looking for it in the same place.
const copyRipgrep = async () => {
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
  const destination = path.resolve(
    import.meta.dirname,
    "resources",
    "bin",
    binaryName
  );

  if (!existsSync(rgPath)) {
    throw new Error(
      `ripgrep binary missing at ${rgPath}. "@vscode/ripgrep" ships it in the ` +
        `@vscode/ripgrep-${process.platform}-${process.arch} optional package.`
    );
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await cp(rgPath, destination);

  // A lost executable bit only surfaces much later, as an EACCES on the first
  // search, so it is re-applied here.
  if (process.platform !== "win32") {
    await chmod(destination, 0o755);
  }
};

const config: ForgeConfig = {
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ["darwin"]),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  packagerConfig: {
    asar: true,
    // `../../packages/db/src/migrations` is copied to Resources/migrations
    // and applied by the packaged main process on startup.
    extraResource: ["./resources", "../../packages/db/src/migrations"],
    icon: "resources/icons",
  },
  plugins: [
    // libsql（`@libsql/<platform>/index.node`）是原生模块，不能从 asar 里
    // dlopen；这个插件把 *.node 解包到 app.asar.unpacked。内置 API server
    // 在打包后加载数据库依赖它。
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          config: "vite.main.config.mts",
          entry: "src/main.ts",
          target: "main",
        },
        {
          // 内置 API server：主进程用 utilityProcess.fork 启动这个产物。
          // Forge 允许第二个 `main` 目标，两者都写到 .vite/build/。
          config: "vite.server.config.mts",
          entry: "src/server-entry.ts",
          target: "main",
        },
        {
          config: "vite.preload.config.mts",
          entry: "src/preload.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          config: "vite.renderer.config.mts",
          name: "main_window",
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  rebuildConfig: {},
  hooks: {
    prePackage: copyRipgrep,
    preStart: copyRipgrep,
    async packageAfterCopy(_forgeConfig, buildPath) {
      const requiredNativePackages = ["@libsql"];
      const sourceNodeModulesPath = path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "node_modules"
      );
      const destNodeModulesPath = path.resolve(buildPath, "node_modules");
      await Promise.all(
        requiredNativePackages.map(async (packageName) => {
          const sourcePath = path.join(sourceNodeModulesPath, packageName);
          const destPath = path.join(destNodeModulesPath, packageName);
          await mkdir(path.dirname(destPath), { recursive: true });
          await cp(sourcePath, destPath, {
            recursive: true,
            preserveTimestamps: true,
          });
        })
      );
    },
  },
};

export default config;
