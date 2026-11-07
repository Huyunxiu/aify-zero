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
