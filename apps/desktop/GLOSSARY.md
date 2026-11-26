# Desktop

The shell around a session: the window, the tray that keeps the process alive, and the system
notice that tells a person a turn settled. It has no vocabulary for what a session does; those
words come from `packages/agent`.

## Language

**Icon Role**:
One of the two icons that the application shows outside its window: the App Icon and the Tray
Icon. Each role has its own Logo Source.
_Avoid_: icon kind, icon type, icon slot

**Logo Source**:
The one file that an icon is built from, and the authority for every size of that icon. A
square drawing: an SVG, or a PNG when there is no vector.
_Avoid_: 原图, 母版, source image, original artwork

**App Icon**:
The icon of the application itself: one opaque rounded square. It reaches the Dock, the app
bundle, the Windows package, and the browser tab, at the size that each one needs. The file
that a browser reads keeps its own name, `favicon.ico`.
_Avoid_: app logo, brand image

**Tray Icon**:
The flat monochrome glyph that the menu bar shows while the process lives. It has its own Logo
Source, because it has no background and macOS tints it.
_Avoid_: tray logo, status icon, menu bar icon
