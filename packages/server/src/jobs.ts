import { JobRegistry } from "@workspace/agent";

/**
 * 进程级后台任务注册表。
 *
 * 任务必须比启动它的那次请求活得久：模型下一轮请求，或者同一轮里的
 * `job-output` 等待，都要能读到它。装配 agent 的每次请求都会新建上下文，
 * 所以注册表放在这里，按会话 id 归属任务。
 */
export const JOB_REGISTRY = new JobRegistry();
