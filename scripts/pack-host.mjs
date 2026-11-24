import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const release = path.join(root, "release");
const filename = "sonora-host.tar.gz";
const destination = path.join(release, filename);

// Keep private files and machine-specific dependencies out of the host package.
// Dependencies are installed on the target.
const entries = [
  ".env.example", ".gitignore", ".github/workflows/ci.yml", "README.md", "CONTRIBUTING.md",
  "package.json", "package-lock.json", "tsconfig.json", "docs/host.md", "docs/github.md",
  "public", "dist/src", "src", "test",
  "scripts/check-host.mjs", "scripts/pack-host.mjs", "scripts/pack-public.mjs", "scripts/remote-access.mjs",
  "scripts/sonora.service.example", "scripts/termux",
];

await mkdir(release, { recursive: true });
const staging = await mkdtemp(path.join(release, ".pack-"));
const archive = path.join(staging, filename);
try {
  for (const entry of entries) {
    await cp(path.join(root, entry), path.join(staging, "sonora", entry), { recursive: true });
  }
  await promisify(execFile)("tar", ["-czf", archive, "-C", staging, "sonora"]);
  await rename(archive, destination);
  console.log(`Pacote do Sonora: ${destination}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
