import "./b.css";
import { createRoot } from "react-dom/client";

import { ShadowLab } from "./lab";

const root = document.querySelector("#root");

if (root) {
  createRoot(root).render(<ShadowLab variant="B" />);
}
