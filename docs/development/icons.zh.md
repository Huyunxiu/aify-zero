# 图标

> 中文副本。以 [`icons.md`](./icons.md) 为准。

图标来自两份 Logo Source。构建它们的命令是 `vp run icons`。

| 源                    | 生成什么  |
| --------------------- | --------- |
| `brand/logo.svg`      | App Icon  |
| `brand/logo-tray.svg` | Tray Icon |

## 命令写出哪些文件

| 文件                                       | 读取方          |
| ------------------------------------------ | --------------- |
| `apps/desktop/resources/icons/icon.icns`   | macOS 应用包    |
| `apps/desktop/resources/icons/icon.png`    | Dock            |
| `apps/desktop/resources/icons/icon.ico`    | Windows 包      |
| `apps/desktop/resources/icons/icon.svg`    | 需要这张图的人  |
| `apps/desktop/resources/icons/tray.png`    | 托盘            |
| `apps/desktop/resources/icons/tray@2x.png` | Retina 上的托盘 |
| `packages/ui/src/assets/app-icon.svg`      | `packages/ui`   |
| `apps/web/public/favicon.ico`              | 浏览器标签页    |

路径是固定的。命令从自己的位置推仓库根，所以当前目录不影响结果。

## 换 logo 的步骤

1. 替换 `brand/logo.svg`，或替换 `brand/logo-tray.svg`。
2. 运行 `vp run icons`。
3. 打开改动的图片看一眼。裁剪错了会立刻暴露。
4. 把图片和源一起提交。

要从别的文件生成，就指名它：

```sh
tsx scripts/generate-icons.ts path/to/logo.svg --tray path/to/tray.svg
```

不给 `--tray`，命令就不动托盘文件。

## 命令检查的规则

- **源是正方形。** 宽的源会让这次运行停下。命令不裁剪。
- **栅格源要够大。** logo 源每边要 1024，因为图标集里有一张 1024。托盘源只要 64，也就是它的
  Retina 尺寸。低于这个值就得放大。改用 SVG。
- **一次只给一份源。** 给出两份源的运行会停下。两份源会各走各的。
- **PNG 的 logo 源填不了两份矢量副本。** 这次运行会写出全部栅格，把 `icon.svg` 和
  `app-icon.svg` 原样留着，并以非零退出。给 SVG 就能填上，或者手工更新这两份副本。
- **托盘源是单一灰度。** 命令在第一个彩色像素处停下。macOS 按 alpha 给托盘字形上色，颜色会
  变成一团灰。

## 命令需要什么

`sips` 与 `iconutil`，macOS 自带。因此命令只在 macOS 上跑，也不进 CI。换 logo 之后由人运行，
并提交二进制。没有检查会报告图标过期。

每条规则的理由写在 [ADR 0036](../adr/0036-an-icon-is-generated-from-its-logo-source.md)。
