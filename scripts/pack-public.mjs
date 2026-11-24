import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const release = path.join(root, "release");
const filename = "sonora-public.tar.gz";

// This is an allowlist, not a copy of the working directory with a few ignores.
// New top-level directories and file formats must be deliberately approved here.
const requiredFiles = [".env.example", "README.md", "package.json", "package-lock.json", "tsconfig.json"];
const exactFiles = new Set([
  ...requiredFiles,
  ".gitignore", ".gitattributes", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md",
  "LICENSE", "LICENSE.md", "LICENSE.txt", ".github/workflows/ci.yml",
  "scripts/sonora.service.example", "scripts/termux/boot", "scripts/termux/run",
]);
const sourceExtensions = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"]);
const directoryExtensions = new Map([
  ["src", sourceExtensions],
  ["test", new Set([...sourceExtensions, ".html", ".css", ".txt", ".md"])],
  ["public", new Set([".html", ".css", ".js", ".mjs", ".svg", ".webmanifest"])],
  ["scripts", new Set([".mjs", ".js", ".ts", ".sh", ".ps1"])],
  ["docs", new Set([".md", ".txt"])],
]);
const rootDirectories = new Set([...directoryExtensions.keys(), ".github"]);
const excludedDirectories = new Set([
  "data", "audio", "audios", "music", "effects", "backups", "node_modules", "dist",
  "release", "coverage", "logs", "log", "tmp", "temp", "private", "secrets",
]);
const sensitiveName = /(?:^|[._-])(?:cookies?|credentials?|secrets?|tokens?|passwords?)(?:$|[._-])/i;
const privateKeyName = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|known_hosts)(?:[._-]|$)/i;
const privateExtension = /\.(?:pem|key|p12|pfx|keystore|log|sqlite3?|db|bak|backup)$/i;

function isExcluded(name, isDirectory, relative) {
  const lower = name.toLowerCase();
  // Only the root environment template is approved; nested copies are not.
  if (relative === ".env.example") return false;
  // This is application code, not the user's audio library.
  if (relative === "src/audio" && isDirectory) return false;
  if (lower.startsWith(".env")) return true;
  if (sensitiveName.test(name) || privateKeyName.test(name) || privateExtension.test(name)) return true;
  if (isDirectory && (name.startsWith(".") || excludedDirectories.has(lower))) {
    return relative !== ".github";
  }
  return name.startsWith(".") && !exactFiles.has(relative) && relative !== ".github";
}

function isAllowedFile(relative) {
  if (exactFiles.has(relative)) return true;
  const top = relative.split("/")[0];
  return directoryExtensions.get(top)?.has(path.extname(relative).toLowerCase()) ?? false;
}

const copied = new Set();
let omitted = 0;

async function collect(directory, prefix, staging) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    if (!prefix && !exactFiles.has(relative) && !rootDirectories.has(relative)) {
      omitted++;
      continue;
    }
    // Include only the reviewed CI workflow, not unrelated publication jobs.
    if (prefix === ".github" && entry.name !== "workflows") continue;
    if (prefix === ".github/workflows" && entry.name !== "ci.yml") continue;
    const source = path.join(directory, entry.name);
    const stat = await lstat(source);
    if (isExcluded(entry.name, stat.isDirectory(), relative) || stat.isSymbolicLink()) {
      omitted++;
      continue;
    }
    if (stat.isDirectory()) {
      await collect(source, relative, staging);
    } else if (stat.isFile() && isAllowedFile(relative)) {
      // Hard links can alias a private file outside the allowlisted tree.
      if (stat.nlink > 1) {
        omitted++;
        continue;
      }
      const destination = path.join(staging, "sonora", relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await chmod(destination, stat.mode & 0o111 ? 0o755 : 0o644);
      copied.add(relative);
    } else {
      omitted++;
    }
  }
}

// Never follow an existing release/ symlink to write outside this project.
await mkdir(release, { recursive: true });
const releaseStat = await lstat(release);
if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink()) {
  throw new Error("release deve ser uma pasta real dentro do projeto, não um link simbólico.");
}
const staging = await mkdtemp(path.join(release, ".public-"));
try {
  await collect(root, "", staging);
  const missing = requiredFiles.filter((entry) => !copied.has(entry));
  if (missing.length > 0) throw new Error("Arquivos públicos obrigatórios ausentes ou inseguros: " + missing.join(", "));
  for (const requiredDirectory of ["src", "public", "test", "scripts"]) {
    if (![...copied].some((entry) => entry.startsWith(requiredDirectory + "/"))) {
      throw new Error("Pasta pública obrigatória vazia ou ausente: " + requiredDirectory);
    }
  }
  const archive = path.join(staging, filename);
  // Ignore user tar/gzip options: only the staged allowlist may enter the archive.
  const tarEnv = { ...process.env };
  delete tarEnv.TAR_OPTIONS;
  delete tarEnv.GZIP;
  await promisify(execFile)("tar", ["-czf", archive, "-C", staging, "sonora"], { env: tarEnv });
  await rename(archive, path.join(release, filename));
  console.log("Pacote público: " + path.join(release, filename));
  console.log(copied.size + " arquivos incluídos; " + omitted + " entradas fora da política omitidas. Revise o conteúdo antes de publicar.");
} finally {
  await rm(staging, { recursive: true, force: true });
}
