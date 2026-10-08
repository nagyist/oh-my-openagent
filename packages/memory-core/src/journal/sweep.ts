import { join } from "node:path"

import { lstat, readdir, readFile, rmdir, unlink } from "../fs/resilient"

export type EmptyJournalKeepReason =
  | "live"
  | "locked"
  | "recent"
  | "no-transcript"
  | "transcript-content"
  | "state-content"
  | "state-unreadable"
  | "other-content"
  | "changed-during-removal"

export type EmptyJournalSweepResult = {
  readonly removed: readonly string[]
  readonly kept: Readonly<Partial<Record<EmptyJournalKeepReason, number>>>
}

export type EmptyJournalSweepOptions = {
  readonly transcriptsDir: string
  readonly minIdleMs?: number
  readonly now?: () => number
  readonly isLive?: (sessionId: string) => boolean
}

const DEFAULT_MIN_IDLE_MS = 10 * 60 * 1000
const TRANSCRIPT = "transcript.jsonl"
const STATE = "state.json"
const LOCK = "state.lock"

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

function stateIsEmpty(raw: string): boolean | "unreadable" {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return "unreadable"
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unreadable"
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "schema_version") continue
    if (value === undefined || value === null || value === 0 || value === false) continue
    return false
  }
  return true
}

async function keepReason(
  journalDir: string,
  cutoffMs: number,
): Promise<EmptyJournalKeepReason | { readonly files: readonly string[] }> {
  const directory = await lstat(journalDir)
  if (directory.mtimeMs > cutoffMs) return "recent"
  const files: string[] = []
  let sawTranscript = false
  for (const entry of await readdir(journalDir, { withFileTypes: true })) {
    if (entry.name === LOCK) return "locked"
    const path = join(journalDir, entry.name)
    if (!entry.isFile()) return "other-content"
    const info = await lstat(path)
    if (info.mtimeMs > cutoffMs) return "recent"
    if (entry.name === TRANSCRIPT) {
      sawTranscript = true
      if (info.size > 0 && (await readFile(path, "utf8")).trim().length > 0) return "transcript-content"
    } else if (entry.name === STATE) {
      const verdict = info.size === 0 ? true : stateIsEmpty(await readFile(path, "utf8"))
      if (verdict === "unreadable") return "state-unreadable"
      if (!verdict) return "state-content"
    } else if (info.size > 0) {
      return "other-content"
    }
    files.push(path)
  }
  if (!sawTranscript) return "no-transcript"
  return { files }
}

/**
 * Deletes journals that never recorded anything (#9737). A journal is removed only when ALL hold:
 * empty transcript, state without entries or reflection progress, no other file with content, no
 * lock, session not live, nothing modified within `minIdleMs`. Removal is file by file plus a
 * non-recursive rmdir, so anything written meanwhile keeps the directory.
 */
export async function sweepEmptyTranscriptJournals(
  options: EmptyJournalSweepOptions,
): Promise<EmptyJournalSweepResult> {
  const cutoffMs = (options.now ?? Date.now)() - (options.minIdleMs ?? DEFAULT_MIN_IDLE_MS)
  const removed: string[] = []
  const kept: Partial<Record<EmptyJournalKeepReason, number>> = {}
  const keep = (reason: EmptyJournalKeepReason): void => {
    kept[reason] = (kept[reason] ?? 0) + 1
  }
  let entries
  try {
    entries = await readdir(options.transcriptsDir, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { removed, kept }
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (options.isLive?.(entry.name) === true) {
      keep("live")
      continue
    }
    const journalDir = join(options.transcriptsDir, entry.name)
    let verdict: Awaited<ReturnType<typeof keepReason>>
    try {
      verdict = await keepReason(journalDir, cutoffMs)
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue
      throw error
    }
    if (typeof verdict === "string") {
      keep(verdict)
      continue
    }
    try {
      for (const file of verdict.files) {
        await unlink(file).catch((error: unknown) => {
          if (errorCode(error) !== "ENOENT") throw error
        })
      }
      await rmdir(journalDir)
      removed.push(entry.name)
    } catch (error) {
      if (errorCode(error) !== "ENOTEMPTY" && errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOENT") throw error
      keep("changed-during-removal")
    }
  }
  return { removed, kept }
}
