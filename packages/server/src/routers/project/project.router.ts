import { publicProcedure } from "../../index";
import { listProjects } from "./project.repository";

// GET /projects — list all projects
const list = publicProcedure
  .route({ method: "GET", path: "/projects" })
  .handler(async () => {
    const projects = await listProjects();
    return { projects };
  });

export const project = {
  list,
};
