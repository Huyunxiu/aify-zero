# 图标

> 中文副本。以 [`icons.md`](./icons.md) 为准。

有两个角色各有一个图标：应用自身，和托盘。每个角色只有一份源，靠 `brand/` 下的固定文件名
找到。构建它们的命令是 `vp run icons`。

| 角色      | 源                    | 可用的另一个名字      |
| --------- | --------------------- | --------------------- |
| App Icon  | `brand/app-icon.svg`  | `brand/app-icon.png`  |
| Tray Icon | `brand/tray-icon.svg` | `brand/tray-icon.png` |

一个角色只有一份源。一次运行同时找到 SVG 与 PNG 就停下，因为两份源会各走各的。

## 命令写出哪些文件

| 文件                                       | 读取方          |
| ------------------------------------------ | --------------- |
| `apps/desktop/resources/icons/icon.icns`   | macOS 应用包    |
| `apps/desktop/resources/icons/icon.png`    | Dock            |
| `apps/desktop/resources/icons/icon.ico`    | Windows 包      |
| `apps/desktop/resources/icons/tray.png`    | 托盘            |
| `apps/desktop/resources/icons/tray@2x.png` | Retina 上的托盘 |
| `apps/web/public/favicon.ico`              | 浏览器标签页    |

路径是固定的。命令从自己的位置推仓库根，所以当前目录不影响结果。

这些路径还关系到 `apps/desktop/forge.config.ts` 里的 `packagerConfig.icon`。它写的是基名
`resources/icons/icon`，由 electron-packager 按平台补扩展名。那里写成目录，会被解析成
`resources/icons.icns`——这个文件不存在，包就继续用 Electron 默认图标。

## 换图标源的步骤

1. 替换 `brand/app-icon.svg` 或 `brand/tray-icon.svg`。
2. 运行 `vp run icons`。
3. 打开改动的图片看一眼。裁剪错了会立刻暴露。
4. 把图片和源一起提交。

要从别的文件为一次运行出图，就指名它：

```sh
tsx scripts/generate-icons.ts path/to/app-icon.svg --tray path/to/tray-icon.svg
```

## 命令检查的规则

- **源是正方形。** 宽的源会让这次运行停下。命令不裁剪。
- **栅格源要够大。** 最短边要覆盖该角色最大的尺寸：应用图标 1024，托盘图标 64。低于这个值
  就得放大。改用 SVG。
- **一个角色一份源。** 一个角色同时有 SVG 与 PNG 的运行会停下。
- **托盘源是单一灰度。** 命令在第一个彩色像素处停下。macOS 按 alpha 给托盘字形上色，颜色会
  变成一团灰。
- **缺托盘源不出声。** 命令会说明，并把托盘文件原样留着。已发布的应用可以没有托盘图标。

命令不写图标的矢量副本。没有东西读它，而没有读取方的副本会过期。

## 命令不生成什么

- **暗色或着色的应用图标。** macOS 能显示，而只有 Icon Composer 的 `.icon` 包能携带它。
  有人手工把它放在 `resources/icons/icon` 旁边时，electron-packager 会用上。
- **两种墨色的标记。** 品牌包若交付一张给浅色背景、一张给深色背景的同一标记，把它们放进
  `brand/` 时命名为 `logo-on-light.*` 与 `logo-on-dark.*`。名字说的是背景，不是墨色。流水线
  暂时不用它们，因为今天还没有地方画这个标记。

## 命令需要什么

`sips` 与 `iconutil`，macOS 自带。因此命令只在 macOS 上跑，也不进 CI。换源之后由人运行，
并提交二进制。没有检查会报告图标过期。

每条规则的理由写在 [ADR 0036](../adr/0036-an-icon-is-generated-from-its-logo-source.md)。
