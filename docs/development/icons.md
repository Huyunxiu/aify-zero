# Icons

Two roles have an icon: the application itself, and the tray. Each role has one source, found by
its fixed name in `brand/`. The command that builds them is `vp run icons`.

| Role      | Source                | Other names it can use |
| --------- | --------------------- | ---------------------- |
| App Icon  | `brand/app-icon.svg`  | `brand/app-icon.png`   |
| Tray Icon | `brand/tray-icon.svg` | `brand/tray-icon.png`  |

A role has one source. A run that finds both an SVG and a PNG of a role stops, because two
sources drift apart.

## What the command writes

| File                                       | Reader                       |
| ------------------------------------------ | ---------------------------- |
| `apps/desktop/resources/icons/icon.icns`   | the macOS app bundle         |
| `apps/desktop/resources/icons/icon.png`    | the Dock                     |
| `apps/desktop/resources/icons/icon.ico`    | the Windows package          |
| `apps/desktop/resources/icons/tray.png`    | the tray                     |
| `apps/desktop/resources/icons/tray@2x.png` | the tray on a Retina display |
| `apps/web/public/favicon.ico`              | the browser tab              |

The paths are fixed. The command finds the repository root from its own location, so the
working directory does not matter.

The paths also matter to `packagerConfig.icon` in `apps/desktop/forge.config.ts`. It names the
base `resources/icons/icon`, and electron-packager adds the extension for each platform. A
directory in its place resolves to `resources/icons.icns`, which does not exist, and the package
then keeps the default Electron icon.

## How to change an icon source

1. Replace `brand/app-icon.svg` or `brand/tray-icon.svg`.
2. Run `vp run icons`.
3. Open the changed images. A wrong crop shows at once.
4. Commit the images with the source.

To build from another file for one run, name it:

```sh
tsx scripts/generate-icons.ts path/to/app-icon.svg --tray path/to/tray-icon.svg
```

## The rules that the command checks

- **A source is square.** A wide source stops the run. The command does not crop.
- **A raster source is big enough.** The smallest side must cover the largest size of its role:
  1024 for the app icon, 64 for the tray icon. Below that, the image would upscale. Pass the SVG
  instead.
- **One source for one role.** A run that finds both an SVG and a PNG of a role stops.
- **A tray source is one grey.** The command stops on the first coloured pixel. macOS tints the
  tray glyph by its alpha, so a colour would become a grey blob.
- **A missing tray source stays quiet.** The command says so and leaves the tray files as they
  are. A shipped app can live without a tray icon.

The command writes no vector copy of an icon. Nothing reads one, and a copy without a reader
goes stale.

## What the command does not build

- **A dark or tinted app icon.** macOS can show one, and only an Icon Composer `.icon` bundle
  carries it. Electron-packager uses such a bundle when a person adds one by hand beside
  `resources/icons/icon`.
- **The mark in two inks.** If a pack delivers one mark for a light background and one for a
  dark background, name them `logo-on-light.*` and `logo-on-dark.*` when they land in `brand/`.
  The name says the background, not the ink. The pipeline does not use them yet, because
  nothing draws that mark.

## What the command needs

`sips` and `iconutil`, which ship with macOS. The command therefore runs on macOS only, and it
does not run in CI. A person runs it after a source change and commits the binaries. No check
reports a stale icon.

The reason for each rule is in
[ADR 0036](../adr/0036-an-icon-is-generated-from-its-logo-source.md).
