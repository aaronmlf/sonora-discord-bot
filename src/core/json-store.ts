import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Serialize writes per destination, including writes from different callers.
const pending = new Map<string, Promise<void>>();
export function saveJson(file: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value, null, 2) + "\n";
  const task = (pending.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, payload, { mode: 0o600 });
    await rename(temporary, file);
  });
  pending.set(file, task);
  void task.finally(() => { if (pending.get(file) === task) pending.delete(file); }).catch(() => {});
  return task;
}
