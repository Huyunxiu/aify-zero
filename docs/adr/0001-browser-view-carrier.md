# 浏览器视图用 WebContentsView 承载

桌面端要在会话面板里嵌入浏览器，先要选 Electron 的承载 API。我们选 `WebContentsView`，
不用 `<webview>`：它是 Electron 当前推荐的 API，主进程自己创建视图、自己决定安全偏好，
长期没有移除风险；代价是原生视图浮在 DOM 之上，几何同步、面板动画和浮层遮挡必须由我们维护。

## Considered Options

- `<webview>`：DOM 元素，布局和遮挡交给 CSS，实现最省事；但 Electron 不推荐新代码使用，长期有移除风险。
- `WebContentsView`（采用）：官方推荐，控制力最强；需要自己同步 bounds、在动画和弹窗期间隐藏视图。
- `BrowserView`：已废弃，不选。

## Consequences

- 面板开合动画期间先隐藏视图，动画结束后再显示，页面会晚约 250ms 出现。
- 模态浮层打开时要隐藏视图，需要维护一个全局遮挡计数。
- 分栏拖拽时由渲染端上报矩形，主进程只负责 `setBounds`。
- 原生视图会盖住 DOM 浮层：Toast 由会话层写入 `--aify-panel-width` 让开面板宽度，模态浮层则统一计数后隐藏视图。
- 以后如果换回 `<webview>`，CDP 层和工具层不用改，只换承载层。
