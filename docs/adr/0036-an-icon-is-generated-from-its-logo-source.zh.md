# 图标由它的 logo 源生成

> 中文副本。以 `0036-an-icon-is-generated-from-its-logo-source.md` 为准。

旧命令接受一张 PNG，把 `icon.icns`、`icon.png` 和 `icon.ico` 写进 `scripts/`。没有任何应用读
这三个文件。应用真正读的文件靠人手工维护，于是它们漂移了：`packages/ui/src/assets/app-icon.svg`
是 `apps/desktop/resources/icons/icon.svg` 的字节相同副本，Windows 包根本没有 `icon.ico`，
网页 favicon 还是脚手架默认值，托盘图标没有任何可供重建的来源。

位图解决不了这件事。应用图标要 1024 像素给图标集，托盘图标要 32。一张固定尺寸的 PNG 要么
放大，要么丢细节。

## 决定

`brand/logo.svg` 是唯一的 Logo Source。命令 `vp run icons` 从它写出全部图标：

- 桌面包用的 `icon.icns`、`icon.png` 和 `icon.ico`；
- 它们旁边的 `icon.svg`，以及 `packages/ui` 里的 `app-icon.svg`，两者都是源的副本；
- 网页入口的 `favicon.ico`。

每一张栅格都由 `sips` 按它需要的尺寸生成。命令从不放大图像。PNG 源只是退路：它必须是正方形，
logo 源每边要 1024，托盘源要 64。PNG 的 logo 源填不了两份矢量副本，所以命令写出全部栅格、
留下那两份副本，并报告这次运行不完整。给出两份源的运行会停下。

Tray Icon 保留自己的 Logo Source，`brand/logo-tray.svg`。托盘字形是扁平的单色图形，没有背景；
App Icon 是不透明的圆角方块，所以一个文件供给不了两者。`--tray` 是可选的：不给它，命令不动
托盘文件。

托盘图标必须是单一灰度，因为 `setTemplateImage(true)` 让 macOS 按 alpha 给它上色。命令解码
托盘图像，在第一个彩色像素处停下，彩色 logo 因此到不了菜单栏然后变成一团灰。

命令自己写 ICO 容器。这个格式对每张图放一行 16 字节的目录项，图本身是 PNG，所以 ImageMagick
在这里买不到任何东西。

命令是本地的出图工具。它需要 macOS 自带的 `sips` 与 `iconutil`，所以它不进 CI。源缺失、不是
正方形、尺寸太小或带颜色时，它以非零退出，并指名是哪个文件。

## 被否决的选项

- **保留 shell 脚本，加装 ImageMagick**：为一个 40 行 TypeScript 就能拼出的容器引入新依赖，
  而且它对托盘源的单一灰度仍然没有检查。
- **两个图标共用一份 logo 源**：应用图标有背景和颜色，托盘字形两者都没有。一个文件不能同时
  是两者，命令还得自带一条“丢掉哪些像素”的规则。
- **从应用图标去掉底色导出托盘字形**：两张图形不同。托盘字形的 alpha 包围盒宽高比是 1.54，
  应用图标的标记是 1.16。托盘字形是人为了菜单栏画的更扁、更宽的变体。
- **母版继续用 2048 的 PNG**：SVG 装着同一份作品且没有分辨率，文本文件还能显示差异。位图源
  还得多一条尺寸下限。
- **保留 `scripts/icon.*`**：它们是旧命令写在无人读取的目录里的产物。

## 后果

- 换 logo 是一个文件的事：替换 `brand/logo.svg`，跑 `vp run icons`，提交二进制。
- App Icon 不会和 `packages/ui` 漂移：命令一次读取写出两份副本。
- Tray Icon 只在它自己的源变化时变化。两个图标不绑在一起，改一个不会弄坏另一个。
- `apps/web/public/manifest.json` 删除了。没有页面链接它，它写着脚手架的名字，还指向两张不
  存在的图。
- 命令不进 CI，所以换 logo 之后要人手动跑。没有检查会报告图标过期。
- 不是正方形的源会让这次运行停下。命令不猜裁剪，因为错的裁剪比失败的运行更糟。
- 用 PNG 的 logo 源时，只有人忽视了非零退出，分支才会带着过期的矢量副本通过。命令写不出它
  手里没有的矢量。
