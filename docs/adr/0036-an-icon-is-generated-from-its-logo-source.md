# An icon is generated from its logo source

The old command took a PNG and wrote `icon.icns`, `icon.png`, and `icon.ico` into `scripts/`.
No application reads those files. The files that the applications read were kept by hand, and
they drifted: `packages/ui/src/assets/app-icon.svg` was a byte-identical copy of
`apps/desktop/resources/icons/icon.svg`, the Windows package had no `icon.ico` at all, the web
favicon was still the default of the scaffold, and the tray icon had no source that a person
could rebuild it from.

A bitmap cannot fix this. The app icon needs 1024 pixels for the icon set, and a tray glyph
needs 32. One PNG at one size either upscales or loses detail.

The package did not use the icon even when the files were right. Forge passed the directory
`resources/icons` as `packagerConfig.icon`, and electron-packager adds an extension to that
path: it looked for `resources/icons.icns`, found nothing, and kept `electron.icns`.

## Decision

`brand/` holds one source for each role, found by a fixed name. `vp run icons` writes every
icon from those sources:

- `app-icon.svg`, or `app-icon.png` when there is no SVG, is the Logo Source of the App Icon.
  It builds `icon.icns`, `icon.png`, and `icon.ico` for the desktop package, and
  `favicon.ico` for the web entry.
- `tray-icon.svg`, or `tray-icon.png`, is the Logo Source of the Tray Icon. It builds
  `tray.png` and `tray@2x.png`.

Every raster comes from `sips` at the size that it needs. The command never scales an image up.
A PNG source must be square, and its smallest side must cover the largest size of its role: 1024
for the app icon and 64 for the tray icon. A vector source has no floor.

A role has one source. A run that finds both an SVG and a PNG of a role stops, because two
sources drift apart. The names are listed with the SVG first, so a message shows the better file
first. The command line can name another file for one run, which keeps a one-off test cheap.

The command writes no vector copy. Neither `resources/icons/icon.svg` nor a copy in
`packages/ui` had a reader: electron-packager accepts `.icns`, `.ico`, and `.png` only, and no
module imports an app icon. A copy without a reader goes stale the first time the source
changes. Both files are gone.

The Tray Icon has its own source because the two drawings differ. The tray glyph is a flat
monochrome drawing with no background. The App Icon is an opaque rounded square.

A tray icon must be one grey, because `setTemplateImage(true)` makes macOS tint it by its
alpha. The command decodes the tray image and stops on the first coloured pixel, so a coloured
logo cannot reach the menu bar as a grey blob.

The command writes the ICO container itself. The format is a 16-byte directory row for each
image, over PNG images, so ImageMagick buys nothing here.

`packagerConfig.icon` names the base `resources/icons/icon`. Electron-packager then adds
`.icns` on macOS, `.ico` on Windows, and `.png` on Linux.

A brand pack also delivers a mark in two inks: one for a light background and one for a dark
background. When such a pack lands, its files go into `brand/` as `logo-on-light.*` and
`logo-on-dark.*`. They are not in the pipeline, because nothing draws that mark yet. The name says the background, not the ink: a
pack that calls the white ink `logo-light` makes every use site flip the meaning, and a use
site is where a mistake survives review.

The command is a local authoring tool. It needs `sips` and `iconutil`, which ship with macOS,
so it does not run in CI. It fails with a non-zero exit and names the file when a source is
missing, is not square, is too small, or carries colour.

## Considered Options

- **Keep the shell script and add ImageMagick**: a new requirement for a container that 40
  lines of TypeScript already builds, and no check on the colour of a tray source.
- **One source for both roles**: an app icon has a background and a colour; a tray glyph has
  neither. One file cannot be both, and the command would need a rule for which pixels to drop.
- **Derive the tray glyph from the app icon by removing the background**: the two drawings
  differ. The alpha box of the tray glyph is 1.54 times as wide as it is high; the mark of the
  app icon is 1.16. The tray glyph is a flatter, wider variant that a person drew for the menu
  bar.
- **Keep the master as a 2048 PNG**: the SVG holds the same artwork with no resolution, and a
  text file shows a diff. A bitmap source also needs a floor on its size.
- **Keep `scripts/icon.*`**: those files were the output of the old command in a directory that
  no application reads.
- **Keep the two vector copies and report an incomplete run for a PNG source**: a file with no
  reader costs a stale copy and a failed run, and buys nothing.
- **Name the theme variants by their ink, as the delivered pack does**: the file then says the
  opposite of the theme that shows it, and every use site has to invert it.

## Consequences

- A new logo is one file: replace `brand/app-icon.svg` or `brand/tray-icon.svg`, run
  `vp run icons`, and commit the binaries.
- The packaged app now carries the generated `.icns` and `.ico`. Before, it carried
  `electron.icns` and the default Windows icon.
- The Tray Icon changes only when its own source changes. The two roles are not tied together,
  so a change to one cannot break the other.
- A missing tray source is not an error. The command reports that the tray files stay as they
  are, because a shipped app can live without a tray icon.
- `apps/web/public/manifest.json` is gone. No page linked it, it named the scaffold, and it
  pointed at two images that do not exist.
- The command does not run in CI, so a person must run it after a source change. No check
  reports a stale icon.
- A source that is not square stops the run. The command does not guess a crop, because a wrong
  crop is worse than a failed run.
- macOS can show an icon in a dark and a tinted appearance, and only an Icon Composer `.icon`
  bundle can carry those. `sips` and `iconutil` cannot build one, so the pipeline does not.
  Electron-packager would use such a bundle when a person adds one by hand.
