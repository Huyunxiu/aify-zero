export type LoggerFunction = (...data: any[]) => void;

export type LogLevel =
  | "error"
  | "warn"
  | "info"
  | "log"
  | "verbose"
  | "debug"
  | "silly";

export interface Logger {
  error: LoggerFunction;
  warn: LoggerFunction;
  info: LoggerFunction;
  log: LoggerFunction;
  verbose: LoggerFunction;
  debug: LoggerFunction;
  silly: LoggerFunction;
  createLogger: ({ scope }: { scope: string }) => Logger;
  setLevel: (level: LogLevel) => void;
}

export const logger: Logger = {
  error: (...data: any[]) => logWrap("error", () => console.error(...data)),
  warn: (...data: any[]) => logWrap("warn", () => console.warn(...data)),
  info: (...data: any[]) => logWrap("info", () => console.info(...data)),
  log: (...data: any[]) => logWrap("log", () => console.log(...data)),
  verbose: (...data: any[]) => logWrap("verbose", () => console.log(...data)),
  debug: (...data: any[]) => logWrap("debug", () => console.debug(...data)),
  silly: (...data: any[]) => logWrap("silly", () => console.log(...data)),
  createLogger: ({ scope }: { scope: string }): Logger => {
    return logger;
  },
  setLevel,
};

export const LEVEL_ORDER_MAP: Record<LogLevel, number> = {
  error: 6,
  warn: 5,
  info: 4,
  log: 4,
  verbose: 3,
  debug: 2,
  silly: 1,
};
let currentLevel: LogLevel = "info";
let currentLevelOrder = LEVEL_ORDER_MAP[currentLevel];
function setLevel(level: LogLevel) {
  currentLevel = level;
  currentLevelOrder = LEVEL_ORDER_MAP[currentLevel];
}

function logWrap(level: LogLevel, logFunction: LoggerFunction) {
  const levelOrder = LEVEL_ORDER_MAP[level] || LEVEL_ORDER_MAP["log"];
  if (levelOrder < currentLevelOrder) {
    return;
  }

  logFunction();
}
