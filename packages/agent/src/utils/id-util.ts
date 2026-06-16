import { v7 as uuidv7 } from "uuid";

export function generateChatId() {
  return uuidv7();
}

export function generateMessageId() {
  return uuidv7();
}
