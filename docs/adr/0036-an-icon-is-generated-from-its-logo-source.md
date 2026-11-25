# An icon is generated from its logo source

The old command took a PNG and wrote `icon.icns`, `icon.png`, and `icon.ico` into `scripts/`.
No application reads those files. The files that the applications read were kept by hand, and
they drifted: `packages/ui/src/assets/app-icon.svg` was a byte-identical copy of
`apps/desktop/resources/icons/icon.svg`, the Windows package had no `icon.ico` at all, the web
favicon was still the default of the scaffold, and the tray icon had no source that a person
could rebuild it from.

A bitmap cannot fix this. The app icon needs 1024 pixels for the icon set, and a tray glyph
needs 32. One PNG at one size either upscales or loses detail.

## Decision

`brand/logo.svg` is the one Logo Source. The command `vp run icons` writes every icon from it:

- `icon.icns`, `icon.png`, and `icon.ico` for the desktop package;
- `icon.svg` next to them, and `app-icon.svg` in `packages/ui`, both a copy of the source;
- `favicon.ico` for the web entry.

Every raster comes from `sips` at the size that it needs. The command never scales an image up.
A PNG source is a fallback only: it must be square, and it needs 1024 on each side for the logo
source and 64 for the tray source. A PNG logo source cannot fill the two SVG copies, so the
command writes every raster, leaves those copies, and reports an incomplete run. A run that
names two sources stops.

The Tray Icon keeps its own Logo Source, `brand/logo-tray.svg`. The tray glyph is a flat
monochrome drawing with no background, and the App Icon is an opaque rounded square, so one
file cannot supply both. `--tray` is optional: without it the command does not touch the tray
files.

A tray icon must be one grey, because `setTemplateImage(true)` makes macOS tint it by its
alpha. The command decodes the tray image and stops on the first coloured pixel, so a coloured
logo cannot reach the menu bar as a grey blob.

The command writes the ICO container itself. The format is a 16-byte directory row for each
image, over PNG images, so ImageMagick buys nothing here.

The command is a local authoring tool. It needs `sips` and `iconutil`, which ship with macOS,
so it does not run in CI. It fails with a non-zero exit and names the file when a source is
missing, is not square, is too small, or carries colour.

## Considered Options

- **Keep the shell script and add ImageMagick**: a new requirement for a container that 40
  lines of TypeScript already builds, and no check on the colour of a tray source.
- **One logo source for both icons**: an app icon has a background and a colour; a tray glyph
  has neither. One file cannot be both, and the command would need a rule for which pixels to
  drop.
- **Derive the tray glyph from the app icon by removing the background**: the two drawings
  differ. The alpha box of the tray glyph is 1.54 times as wide as it is high; the mark of the
  app icon is 1.16. The tray glyph is a flatter, wider variant that a person drew for the menu
  bar.
- **Keep the master as a 2048 PNG**: the SVG holds the same artwork with no resolution, and a
  text file shows a diff. A bitmap source also needs a floor on its size.
- **Keep `scripts/icon.*`**: those files were the output of the old command in a directory that
  no application reads.

## Consequences

- A new logo is one file: replace `brand/logo.svg`, run `vp run icons`, and commit the
  binaries.
- The App Icon cannot drift from `packages/ui`: the command writes both copies from one read.
- The Tray Icon changes only when its own source changes. The two icons are not tied together,
  so a change to one cannot break the other.
- `apps/web/public/manifest.json` is gone. No page linked it, it named the scaffold, and it
  pointed at two images that do not exist.
- The command does not run in CI, so a person must run it after a logo change. No check reports
  a stale icon.
- A source that is not square stops the run. The command does not guess a crop, because a wrong
  crop is worse than a failed run.
- A feature branch can pass with a PNG logo source and stale vector copies only if a person
  ignores the non-zero exit. The command cannot write a vector that it does not have.
