/**
 * Local output retention -- this is a background service that writes
 * continuously for as long as the Gateway runs, unlike `redundo collect`
 * (a developer manually starts and stops for one capture session).
 * Unbounded local capture is a real disk-exhaustion risk on a long-lived
 * Gateway, not a hypothetical. See the plan's "Local output retention"
 * section.
 *
 * Sweep order: age-based eviction first (delete anything older than
 * maxAgeDays), then size-based eviction as a backstop (if still over
 * maxOutputBytes after that, delete the oldest remaining files until
 * under budget). Never touches anything younger than SAFETY_MARGIN_MS --
 * defense in depth against a file that might still be mid-write, even
 * though every batch file here is written once and closed, same atomic-
 * per-batch pattern `redundo collect` already uses (no appending across
 * time, so there's no genuine partial-write window in practice).
 */

import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

const SAFETY_MARGIN_MS = 60_000;

export interface RetentionResult {
  deletedFiles: number;
  deletedBytes: number;
}

interface FileInfo {
  path: string;
  mtimeMs: number;
  size: number;
}

async function listOtlpFiles(outputDir: string): Promise<FileInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(outputDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: FileInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".otlp.json")) continue;
    const fullPath = path.join(outputDir, entry);
    try {
      const info = await stat(fullPath);
      if (info.isFile()) files.push({ path: fullPath, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      // Deleted between readdir and stat -- fine, nothing to sweep.
    }
  }
  return files;
}

async function deleteFile(file: FileInfo): Promise<boolean> {
  try {
    await unlink(file.path);
    return true;
  } catch {
    return false; // already gone, or a permissions issue -- not fatal to the sweep
  }
}

export async function sweepRetention(
  outputDir: string,
  maxAgeDays: number,
  maxOutputBytes: number,
  now: number = Date.now(),
): Promise<RetentionResult> {
  const files = await listOtlpFiles(outputDir);
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const safeCutoff = now - SAFETY_MARGIN_MS;

  let deletedFiles = 0;
  let deletedBytes = 0;
  const remaining: FileInfo[] = [];

  for (const file of files) {
    const age = now - file.mtimeMs;
    if (age > maxAgeMs && file.mtimeMs < safeCutoff) {
      if (await deleteFile(file)) {
        deletedFiles += 1;
        deletedBytes += file.size;
        continue;
      }
    }
    remaining.push(file);
  }

  remaining.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  let totalBytes = remaining.reduce((sum, f) => sum + f.size, 0);
  for (const file of remaining) {
    if (totalBytes <= maxOutputBytes) break;
    if (file.mtimeMs >= safeCutoff) continue; // never touch anything within the safety margin
    if (await deleteFile(file)) {
      deletedFiles += 1;
      deletedBytes += file.size;
      totalBytes -= file.size;
    }
  }

  return { deletedFiles, deletedBytes };
}
