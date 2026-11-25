# Icons

The icons come from two Logo Sources. The command that builds them is `vp run icons`.

| Source                | What it builds |
| --------------------- | -------------- |
| `brand/logo.svg`      | the App Icon   |
| `brand/logo-tray.svg` | the Tray Icon  |

## What the command writes

| File                                       | Reader                       |
| ------------------------------------------ | ---------------------------- |
| `apps/desktop/resources/icons/icon.icns`   | the macOS app bundle         |
| `apps/desktop/resources/icons/icon.png`    | the Dock                     |
| `apps/desktop/resources/icons/icon.ico`    | the Windows package          |
| `apps/desktop/resources/icons/icon.svg`    | a person who needs the art   |
| `apps/desktop/resources/icons/tray.png`    | the tray                     |
| `apps/desktop/resources/icons/tray@2x.png` | the tray on a Retina display |
| `packages/ui/src/assets/app-icon.svg`      | `packages/ui`                |
| `apps/web/public/favicon.ico`              | the browser tab              |

The paths are fixed. The command finds the repository root from its own location, so the
working directory does not matter.

## How to change a logo

1. Replace `brand/logo.svg`, or `brand/logo-tray.svg`.
2. Run `vp run icons`.
3. Open the changed images. A wrong crop shows at once.
4. Commit the images with the source.

To build from another file, name it:

```sh
tsx scripts/generate-icons.ts path/to/logo.svg --tray path/to/tray.svg
```

Without `--tray`, the command does not touch the tray files.

## The rules that the command checks

- **A source is square.** A wide source stops the run. The command does not crop.
- **A raster source is big enough.** The logo source needs 1024 on each side, because the icon
  set has a 1024 image. A tray source needs 64, which is its Retina size. Below that, the image
  would upscale. Pass the SVG instead.
- **One source at a time.** A run that names two sources stops. Two sources drift apart.
- **A PNG logo source cannot fill the two vector copies.** The run writes every raster, keeps
  `icon.svg` and `app-icon.svg` as they are, and exits non-zero. Pass the SVG to fill them, or
  update the two copies by hand.
- **A tray source is one grey.** The command stops on the first coloured pixel. macOS tints the
  tray glyph by its alpha, so a colour would become a grey blob.

## What the command needs

`sips` and `iconutil`, which ship with macOS. The command therefore runs on macOS only, and it
does not run in CI. A person runs it after a logo change and commits the binaries. No check
reports a stale icon.

The reason for each rule is in
[ADR 0036](../adr/0036-an-icon-is-generated-from-its-logo-source.md).
