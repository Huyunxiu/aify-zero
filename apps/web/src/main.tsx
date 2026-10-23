/**
 * apps/web 是唯一的前端入口：
 * - 浏览器：`vite dev` / `vite build` 独立运行；
 * - 桌面：Forge 的 renderer 构建复用同一份源码，窗口通过 aify-app:// 加载。
 *
 * 应用本体在 @workspace/ui/app.tsx，它自己挂载到 #root。
 */
import "@workspace/ui/app.tsx";
import { initDesktopIpc } from "./platform/desktop";

void initDesktopIpc();
