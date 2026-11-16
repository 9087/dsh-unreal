/**
 * Adapter-owned screenshot files.
 *
 * The adapter — not the editor — chooses the file name: captures go into a temp
 * directory under a timestamp+uuid name, so two calls can never overwrite each
 * other and a recorded history preview keeps pointing at unchanged bytes. The
 * panel never embeds image bytes in the durable record; it asks the host for
 * them by record id, and this module is the only place that turns a recorded
 * path into bytes.
 *
 * @module dsh-unreal/screenshots
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** Largest PNG the preview endpoint is willing to read into memory. */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024

/**
 * The temp directory that holds this adapter's screenshots.
 *
 * @returns the absolute directory (not created by this call).
 */
export function screenshotRoot(): string {
  return join(tmpdir(), 'dsh-unreal', 'screenshots')
}

/**
 * Create and return a fresh PNG path under {@link screenshotRoot}.
 *
 * @returns the absolute path; the directory has been created.
 */
export async function newScreenshotPath(): Promise<string> {
  const root = screenshotRoot()
  await mkdir(root, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  return join(root, `shot-${stamp}-${randomUUID().slice(0, 8)}.png`)
}

/**
 * Whether a path is one of this adapter's own screenshot files.
 *
 * The preview endpoint only serves files under {@link screenshotRoot}, so a
 * record cannot be used to read an arbitrary file.
 *
 * @param filePath - the path recorded on the operation.
 * @returns true when the resolved path is inside the temp screenshot root.
 */
export function isOwnScreenshotPath(filePath: string): boolean {
  const root = resolve(screenshotRoot())
  const target = resolve(filePath)
  return target === root || target.startsWith(root + sep)
}

/**
 * Read one PNG's width and height from its IHDR chunk.
 *
 * @param filePath - the PNG path.
 * @returns the dimensions, or `undefined` when the file is not a readable PNG.
 */
export async function pngSize(filePath: string): Promise<{ width: number; height: number } | undefined> {
  try {
    const buffer = await readFile(filePath)
    if (buffer.length < 24) return undefined
    const pngSignature = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    if (!pngSignature) return undefined
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  } catch {
    return undefined
  }
}

/**
 * Read one recorded screenshot as a data URL for the history panel.
 *
 * @param filePath - the path recorded on the operation.
 * @returns the PNG data URL, or `undefined` when the file is gone, too large, or not ours.
 */
export async function readScreenshotDataUrl(filePath: string): Promise<string | undefined> {
  if (!isOwnScreenshotPath(filePath)) return undefined
  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size === 0 || info.size > MAX_PREVIEW_BYTES) return undefined
    const bytes = await readFile(filePath)
    return `data:image/png;base64,${bytes.toString('base64')}`
  } catch {
    return undefined
  }
}
