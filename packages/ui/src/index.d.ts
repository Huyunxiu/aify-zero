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
 * The bulk asset import of Vite. Only one form is in use: it evaluates at once and
 * returns the URL of each file, as `{ file path: URL }`. See `blocks/brand-icon.tsx`.
 */
interface ImportMeta {
  glob(
    pattern: string,
    options: { eager: true; query: "?url"; import: "default" }
  ): Record<string, string>;
}
