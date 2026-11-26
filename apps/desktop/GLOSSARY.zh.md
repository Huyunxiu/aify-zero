# 桌面端

> 中文副本。以 [`GLOSSARY.md`](./GLOSSARY.md) 为准。

会话外面的壳：窗口、让进程活下去的托盘，以及告诉人一次回合结束了的系统通知。它没有描述会话
内部事情的词；那些词来自 `packages/agent`。

## Language

**图标角色 (Icon Role)**:
应用在窗口之外显示的那两个图标之一：应用图标与托盘图标。每个角色有自己的 logo 源。
_Avoid_: 图标类型、图标种类、图标位

**logo 源 (Logo Source)**:
用来生成一个图标的那一个文件，也是该图标每个尺寸的权威。它是一张正方形图形：SVG，或者在没有
矢量时的 PNG。
_Avoid_: 原图、母版、source image、original artwork

**应用图标 (App Icon)**:
应用自身的图标：一个不透明的圆角方块。它按各自需要的尺寸出现在 Dock、应用包、Windows 包和
浏览器标签页上。浏览器读的那个文件保留自己的名字 `favicon.ico`。
_Avoid_: 应用 logo、品牌图

**托盘图标 (Tray Icon)**:
进程活着时菜单栏显示的那个扁平单色字形。它有自己的 logo 源，因为它没有背景，而且 macOS 会给
它上色。
_Avoid_: 托盘 logo、状态栏图标、菜单栏图标
