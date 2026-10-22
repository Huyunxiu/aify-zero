import { isAbsolute, resolve } from "node:path";

import z from "zod";

/**
 * 每个目录都必须是绝对路径：`getProjectDirs` 把它们原样交给 agent，相对路径
 * 会随进程的工作目录漂移，同一个项目在两台机器上指向不同的地方。
 *
 * 落库前再归一化一次：`/a/b/` 和 `/a/b` 是同一个目录，而唯一索引只看字符串，
 * 不归一化就会让同一个目录挂上两个项目。
 */
const absoluteDir = z
  .string()
  .trim()
  .min(1, "Project directory is required")
  .refine((value) => isAbsolute(value), {
    message: "Project directory must be an absolute path",
  })
  .transform((value) => resolve(value));

const projectFields = {
  name: z.string().trim().min(1, "Project name is required"),
  primaryDir: absoluteDir,
  /**
   * 主目录之外额外可访问的根，约定不包含 `primaryDir`（见 `project_table`）。
   * 每个都是绝对路径、互不重复、且不等于主目录，写入前在这里保证。
   */
  additionalDirs: z.array(absoluteDir).default([]),
};

/** 附加目录不能重复，也不能包含主目录。 */
function dirsAreDistinct(input: {
  primaryDir: string;
  additionalDirs: string[];
}) {
  const dirs = new Set(input.additionalDirs);
  return (
    dirs.size === input.additionalDirs.length && !dirs.has(input.primaryDir)
  );
}

const distinctDirsOptions = {
  message:
    "Additional directories must be unique and differ from the primary directory",
  path: ["additionalDirs"],
};

export const projectCreateSchema = z
  .object(projectFields)
  .refine(dirsAreDistinct, distinctDirsOptions);

export const projectUpdateSchema = z
  .object({
    projectId: z.string(),
    ...projectFields,
  })
  .refine(dirsAreDistinct, distinctDirsOptions);

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;
