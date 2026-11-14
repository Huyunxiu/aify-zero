declare module "*.svg" {
  // const content: React.FunctionComponent<React.SVGAttributes<SVGElement>>;
  const content: string;
  export default content;
}

declare module "*.css";

declare module "@wterm/dom/css";

declare module "*?url" {
  const url: string;
  export default url;
}

/**
 * Vite 的批量资源导入。这里只用到一种形态：立刻求值、取每个文件的 URL，
 * 结果是 `{ 文件路径: URL }`。见 `elements/brand-icon.tsx`。
 */
interface ImportMeta {
  glob(
    pattern: string,
    options: { eager: true; query: "?url"; import: "default" }
  ): Record<string, string>;
}
