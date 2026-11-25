# 图标由它的 logo 源生成

> 中文副本。以 `0036-an-icon-is-generated-from-its-logo-source.md` 为准。

旧命令接受一张 PNG，把 `icon.icns`、`icon.png` 和 `icon.ico` 写进 `scripts/`。没有任何应用读
这三个文件。应用真正读的文件靠人手工维护，于是它们漂移了：`packages/ui/src/assets/app-icon.svg`
是 `apps/desktop/resources/icons/icon.svg` 的字节相同副本，Windows 包根本没有 `icon.ico`，
网页 favicon 还是脚手架默认值，托盘图标没有任何可供重建的来源。

位图解决不了这件事。应用图标要 1024 像素给图标集，托盘图标要 32。一张固定尺寸的 PNG 要么
放大，要么丢细节。

就算文件是对的，包也没有用上图标。Forge 把目录 `resources/icons` 交给
`packagerConfig.icon`，而 electron-packager 会在这个路径后面补扩展名：它找
`resources/icons.icns`，没找到，于是保留 `electron.icns`。

## 决定

`brand/` 给每个角色放一份源，靠固定文件名找到。`vp run icons` 从这些源写出全部图标：

- App Icon 的 Logo Source 是 `app-icon.svg`，没有 SVG 时是 `app-icon.png`。它生成桌面包用的
  `icon.icns`、`icon.png`、`icon.ico`，以及网页入口的 `favicon.ico`。
- Tray Icon 的 Logo Source 是 `tray-icon.svg`，没有 SVG 时是 `tray-icon.png`。它生成
  `tray.png` 与 `tray@2x.png`。

每一张栅格都由 `sips` 按它需要的尺寸生成。命令从不放大图像。PNG 源必须是正方形，最短边要
覆盖该角色最大的尺寸：应用图标 1024，托盘图标 64。矢量源没有下限。

一个角色只有一份源。一次运行同时找到 SVG 与 PNG 就停下，因为两份源会各走各的。名字列表里
SVG 在前，所以消息先给出更合适的文件。命令行可以为一次运行指定别的文件，这让一次性试验很便宜。

命令不写任何矢量副本。`resources/icons/icon.svg` 和 `packages/ui` 里的副本都没有读取方：
electron-packager 只接受 `.icns`、`.ico`、`.png`，也没有模块 import 应用图标。没有读取方的
副本会在源第一次改动时过期。这两个文件都删了。

Tray Icon 有自己的源，因为两张图形不同。托盘字形是扁平的单色图形，没有背景；App Icon 是
不透明的圆角方块。

托盘图标必须是单一灰度，因为 `setTemplateImage(true)` 让 macOS 按 alpha 给它上色。命令解码
托盘图像，在第一个彩色像素处停下，彩色 logo 因此到不了菜单栏然后变成一团灰。

命令自己写 ICO 容器。这个格式对每张图放一行 16 字节的目录项，图本身是 PNG，所以 ImageMagick
在这里买不到任何东西。

`packagerConfig.icon` 指向基名 `resources/icons/icon`。electron-packager 随后在 macOS 上加
`.icns`，在 Windows 上加 `.ico`，在 Linux 上加 `.png`。

品牌包通常还交付同一标记的两种墨色：一种用在浅色背景上，一种用在深色背景上。这样的包到手时，
把它的文件放进 `brand/` 并命名为 `logo-on-light.*` 与 `logo-on-dark.*`。它们不进流水线，因为
今天还没有地方画这个标记。
名字说的是**背景**，不是**墨色**：把白墨叫成 `logo-light` 的包，会让每个使用处都翻转一次含义，
而使用处正是错误能活过评审的地方。

命令是本地的出图工具。它需要 macOS 自带的 `sips` 与 `iconutil`，所以它不进 CI。源缺失、不是
正方形、尺寸太小或带颜色时，它以非零退出，并指名是哪个文件。

## 被否决的选项

- **保留 shell 脚本，加装 ImageMagick**：为一个 40 行 TypeScript 就能拼出的容器引入新依赖，
  而且它对托盘源的单一灰度仍然没有检查。
- **两个角色共用一份源**：应用图标有背景和颜色，托盘字形两者都没有。一个文件不能同时是两者，
  命令还得自带一条“丢掉哪些像素”的规则。
- **从应用图标去掉底色导出托盘字形**：两张图形不同。托盘字形的 alpha 包围盒宽高比是 1.54，
  应用图标的标记是 1.16。托盘字形是人为了菜单栏画的更扁、更宽的变体。
- **logo 源继续用 2048 的 PNG**：SVG 装着同一份作品且没有分辨率，文本文件还能显示差异。位图源
  还得多一条尺寸下限。
- **保留 `scripts/icon.*`**：它们是旧命令写在无人读取的目录里的产物。
- **留着两份矢量副本，PNG 源时报告运行不完整**：一个没有读取方的文件换来过期副本加一次失败的
  运行，什么也没买到。
- **像交付的品牌包那样按墨色命名主题版本**：文件于是和显示它的主题相反，每个使用处都要自己翻转。

## 后果

- 换 logo 是一个文件的事：替换 `brand/app-icon.svg` 或 `brand/tray-icon.svg`，跑
  `vp run icons`，提交二进制。
- 打包出来的应用现在带着生成的 `.icns` 与 `.ico`。在此之前，它带的是 `electron.icns` 和
  Windows 默认图标。
- Tray Icon 只在它自己的源变化时变化。两个角色不绑在一起，改一个不会弄坏另一个。
- 缺托盘源不是错误。命令会说明托盘文件保持原样，因为已发布的应用可以没有托盘图标。
- `apps/web/public/manifest.json` 删除了。没有页面链接它，它写着脚手架的名字，还指向两张不
  存在的图。
- 命令不进 CI，所以换源之后要人手动跑。没有检查会报告图标过期。
- 不是正方形的源会让这次运行停下。命令不猜裁剪，因为错的裁剪比失败的运行更糟。
- macOS 能按深色和着色外观显示图标，而只有 Icon Composer 的 `.icon` 包能携带这些。`sips` 与
  `iconutil` 造不出来，所以流水线不做。有人手工加上这样的包时，electron-packager 会用上它。
