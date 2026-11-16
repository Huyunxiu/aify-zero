import { nanoid } from "nanoid";
import { v7 as uuidv7 } from "uuid";

/** 会话 id：时间有序，按创建顺序排列。 */
export function generateSessionId(): string {
  return uuidv7();
}

/** 回合 id：和会话 id 同一套时间有序格式。 */
export function generateTurnId(): string {
  return uuidv7();
}

/** 步 id：短、可读，只在会话内唯一。 */
export function generateStepId(): string {
  return nanoid(10);
}

/** 协议事件 id：和步 id 同一套短格式。 */
export function generateEventId(): string {
  return nanoid(10);
}
