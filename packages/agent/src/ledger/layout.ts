import { join } from "node:path";

/** The file a session's ledger lives in, under its own directory. */
const LEDGER_FILE = "ledger.jsonl";

/** The directory that holds the stored system prompts, one file per digest. */
const LEDGER_PROMPT_DIR = join("ledger", "prompts");

/** Where one session keeps its ledger. */
export function ledgerPath(sessionDir: string): string {
  return join(sessionDir, LEDGER_FILE);
}

/** Where one session keeps the system prompts its turns ran under. */
export function ledgerPromptDir(sessionDir: string): string {
  return join(sessionDir, LEDGER_PROMPT_DIR);
}

/**
 * The file that holds one prompt.
 *
 * The digest names the bytes, so the same prompt twice is the same file and one session
 * keeps one copy of it.
 */
export function ledgerPromptPath(sessionDir: string, sha256: string): string {
  return join(ledgerPromptDir(sessionDir), sha256);
}
