import { v7 as uuidv7 } from "uuid";

export function generateSessionId() {
  return uuidv7();
}

export function generateMessageId() {
  return uuidv7();
}

export function generatePartId() {
  return uuidv7();
}
