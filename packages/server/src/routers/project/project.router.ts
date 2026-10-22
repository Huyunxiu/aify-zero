import { ApiError } from "../../errors";
import { publicProcedure } from "../../index";
import {
  createProject,
  findProjectById,
  findProjectByPrimaryDir,
  listProjects,
  updateProject,
} from "./project.repository";
import { projectCreateSchema, projectUpdateSchema } from "./project.schema";

// GET /projects — list all projects
const list = publicProcedure
  .route({ method: "GET", path: "/projects" })
  .handler(async () => {
    const projects = await listProjects();
    return { projects };
  });

// POST /projects — create a project
const create = publicProcedure
  .route({ method: "POST", path: "/projects" })
  .input(projectCreateSchema)
  .handler(async ({ input }) => {
    // 一个目录只能是一个项目的主目录：提前查一次，把唯一索引的冲突说清楚，
    // 而不是让 insert 抛一个约束错误变成 500。
    const existing = await findProjectByPrimaryDir(input.primaryDir);
    if (existing) {
      throw new ApiError("PROJECT_DIR_EXISTS", {
        data: { primaryDir: input.primaryDir },
      });
    }

    return await createProject({
      name: input.name,
      primaryDir: input.primaryDir,
      additionalDirs: input.additionalDirs,
    });
  });

// PUT /projects/{projectId} — update a project
const update = publicProcedure
  .route({ method: "PUT", path: "/projects/{projectId}" })
  .input(projectUpdateSchema)
  .handler(async ({ input }) => {
    const { projectId, ...data } = input;

    const existing = await findProjectById(projectId);
    if (!existing) {
      throw new ApiError("PROJECT_NOT_FOUND", { data: { projectId } });
    }

    // 换主目录也要保证目录唯一；查到的是自己时不算冲突。
    const clash = await findProjectByPrimaryDir(data.primaryDir);
    if (clash && clash.id !== projectId) {
      throw new ApiError("PROJECT_DIR_EXISTS", {
        data: { primaryDir: data.primaryDir },
      });
    }

    return await updateProject(projectId, data);
  });

export const project = {
  list,
  create,
  update,
};
