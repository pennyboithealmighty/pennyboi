// Tiny leveled logger (LOG_LEVEL=debug|info|warn|error).
import { envStr } from "@pennyboi/shared";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(envStr("LOG_LEVEL", "info") as Level)] ?? LEVELS.info;

function emit(level: Level, msg: string, extra?: unknown) {
  if (LEVELS[level] < threshold) return;
  const tag = `[mouth] ${new Date().toISOString()} ${level.toUpperCase()}`;
  if (extra !== undefined) console.log(tag, msg, extra);
  else console.log(tag, msg);
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
export type Logger = typeof log;
