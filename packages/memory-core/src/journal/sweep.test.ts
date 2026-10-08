import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { sweepEmptyTranscriptJournals } from "./sweep"
import { removeTree } from "../../../../test-support/remove-tree"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTree(dir, { maxRetries: 10, retryDelay: 200 })))
})

const NOW = Date.parse("2026-10-08T12:00:00.000Z")
const OLD = new Date(NOW - 60 * 60 * 1000)
const EMPTY_STATE = `${JSON.stringify({
  unreflected_bytes: 0,
  schema_version: "v3_assistant_steps",
  total_completed_steps: 0,
  reflected_completed_steps: 0,
  steps_since_last_successful_reflection: 0,
  reflected_through_byte_offset: 0,
}, null, 2)}\n`

async function transcriptsDir(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "memory-journal-sweep-")))
  tempDirs.push(dir)
  return dir
}

async function journal(
  root: string,
  sessionId: string,
  files: Record<string, string>,
  modifiedAt: Date = OLD,
): Promise<string> {
  const dir = join(root, sessionId)
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8")
    await utimes(join(dir, name), modifiedAt, modifiedAt)
  }
  await utimes(dir, modifiedAt, modifiedAt)
  return dir
}

describe("empty transcript journal sweep (#9737)", () => {
  it("#given an old journal with an empty transcript and an empty state #when swept #then it is removed and counted", async () => {
    // given
    const root = await transcriptsDir()
    const dir = await journal(root, "control-1", { "transcript.jsonl": "", "state.json": EMPTY_STATE })

    // when
    const result = await sweepEmptyTranscriptJournals({ transcriptsDir: root, now: () => NOW })

    // then
    expect(result.removed).toEqual(["control-1"])
    expect(existsSync(dir)).toBe(false)
  })

  it("#given journals that hold anything or are still in use #when swept #then every one is kept with its reason", async () => {
    // given
    const root = await transcriptsDir()
    const row = `${JSON.stringify({ kind: "user", text: "hi", captured_at: "x", source_line_id: "u1:user", source_message_id: "u1" })}\n`
    const keepers = [
      await journal(root, "with-transcript", { "transcript.jsonl": row, "state.json": EMPTY_STATE }),
      await journal(root, "with-steps", {
        "transcript.jsonl": "",
        "state.json": JSON.stringify({ schema_version: "v3_assistant_steps", total_completed_steps: 2 }),
      }),
      await journal(root, "with-reflection", {
        "transcript.jsonl": "",
        "state.json": JSON.stringify({ schema_version: "v3_assistant_steps", last_reflection_started_at: "2026-10-01T00:00:00.000Z" }),
      }),
      await journal(root, "with-unreadable-state", { "transcript.jsonl": "", "state.json": "{not json" }),
      await journal(root, "with-other-file", { "transcript.jsonl": "", "state.json": EMPTY_STATE, "notes.txt": "keep" }),
      await journal(root, "locked", { "transcript.jsonl": "", "state.json": EMPTY_STATE, "state.lock": "123\n" }),
      await journal(root, "recent", { "transcript.jsonl": "", "state.json": EMPTY_STATE }, new Date(NOW - 60 * 1000)),
      await journal(root, "live-session", { "transcript.jsonl": "", "state.json": EMPTY_STATE }),
      await journal(root, "no-transcript", { "state.json": EMPTY_STATE }),
    ]

    // when
    const result = await sweepEmptyTranscriptJournals({
      transcriptsDir: root,
      now: () => NOW,
      isLive: (sessionId) => sessionId === "live-session",
    })

    // then
    expect(result.removed).toEqual([])
    for (const dir of keepers) expect(existsSync(dir)).toBe(true)
    expect(result.kept).toEqual({
      "transcript-content": 1,
      "state-content": 2,
      "state-unreadable": 1,
      "other-content": 1,
      locked: 1,
      recent: 1,
      live: 1,
      "no-transcript": 1,
    })
  })

  it("#given a whitespace-only transcript and a state file of zero bytes #when swept #then the journal still counts as empty", async () => {
    // given
    const root = await transcriptsDir()
    await journal(root, "blank", { "transcript.jsonl": "\n\n", "state.json": "" })

    // when
    const result = await sweepEmptyTranscriptJournals({ transcriptsDir: root, now: () => NOW })

    // then
    expect(result.removed).toEqual(["blank"])
  })

  it("#given no transcripts directory #when swept #then nothing happens", async () => {
    // given
    const root = join(await transcriptsDir(), "missing")

    // when
    const result = await sweepEmptyTranscriptJournals({ transcriptsDir: root, now: () => NOW })

    // then
    expect(result).toEqual({ removed: [], kept: {} })
  })
})
