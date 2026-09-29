import { nanoid } from "nanoid";
import { v7 as uuidv7 } from "uuid";

export function generateSessionId() {
  return uuidv7();
}

export function generateTurnId() {
  return uuidv7();
}

export function generateStepId() {
  return nanoid(10);
}

export function generateEventId() {
  return nanoid(10);
}
