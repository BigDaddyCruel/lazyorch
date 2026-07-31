import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Read a JSON file and parse it.
 * @returns null if the file does not exist
 */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Atomically write JSON (temp file in same directory + rename).
 * Pretty-printed with trailing newline for human-friendly git diffs.
 */
export async function writeJsonFile(
  path: string,
  value: unknown,
  space: number = 2,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(value, null, space)}\n`;
  const tmp = join(
    dirname(path),
    `.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(tmp, body, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
