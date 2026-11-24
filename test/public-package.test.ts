import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(projectRoot, "scripts", "pack-public.mjs");
const archiveRelative = "release/sonora-public.tar.gz";

async function put(root: string, relative: string, content = "public fixture\n"): Promise<void> {
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sonora-public-package-"));
  for (const file of [
    ".env.example", "README.md", "package.json", "package-lock.json", "tsconfig.json",
    "src/index.ts", "src/audio/session-mixer.ts", "public/index.html", "test/session-mixer.test.ts",
  ]) await put(root, file);
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await copyFile(scriptPath, path.join(root, "scripts", "pack-public.mjs"));
  return root;
}

async function pack(root: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  await execFileAsync(process.execPath, [path.join(root, "scripts", "pack-public.mjs")], {
    env: env ?? process.env,
  });
  const { stdout } = await execFileAsync("tar", ["-tzf", path.join(root, archiveRelative)]);
  return stdout.trim().split("\n");
}

describe("pacote público", () => {
  it("inclui código, templates, documentação, CI revisado e scripts de hospedagem", async () => {
    const root = await fixture();
    const approved = [
      ".gitignore", ".gitattributes", "CONTRIBUTING.md", "LICENSE",
      ".github/workflows/ci.yml", "docs/host.md", "docs/github.md",
      "scripts/sonora.service.example", "scripts/termux/run", "scripts/termux/boot",
      "public/icon.svg", "public/manifest.webmanifest",
    ];
    try {
      for (const file of approved) await put(root, file);
      const files = await pack(root);
      for (const file of [...approved, ".env.example", "src/audio/session-mixer.ts", "test/session-mixer.test.ts"]) {
        assert.ok(files.includes("sonora/" + file), file);
      }
      assert.ok(files.every((file) => file.startsWith("sonora/")));
      assert.equal(files.includes("sonora/release/"), false);
      assert.deepEqual(await readdir(path.join(root, "release")), ["sonora-public.tar.gz"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omite dados privados e artefatos também quando escondidos dentro de pastas aprovadas", async () => {
    const root = await fixture();
    const forbidden = [
      ".env", ".env.production", "data/access.json", "audio/personal.mp3", "backups/config.json",
      "outro-projeto/index.ts", "dist/src/index.js", "node_modules/example/index.js",
      ".git/config", ".codex/config.json", ".aws/credentials", "unapproved/notes.md",
      ".github/workflows/publish.yml", "public/private/notes.js", "public/.env.example",
      "src/data/access.json", "src/.aws/config.json", "src/.codex/config.json", "src/.git/config",
      "src/credentials.json", "src/password.txt", "src/user-token.json", "src/cookies.txt",
      "test/audio/sample.mp3", "test/music/a.json", "test/effects/a.json", "test/backups/a.json",
      "test/node_modules/fixture.ts", "test/dist/test.ts", "test/private/outro-projeto/index.ts",
      "test/private.json.bak", "test/recording.wav", "test/db.sqlite", "test/id_rsa",
      "docs/secrets/notes.md", "docs/config.env", "docs/server.log", "docs/screenshots/private.png",
      "scripts/access.key", "scripts/.cache/something.js", "scripts/release/archive.js",
    ];
    try {
      for (const file of forbidden) await put(root, file, "PRIVATE_FIXTURE_ONLY");
      const files = await pack(root);
      for (const file of forbidden) assert.equal(files.includes("sonora/" + file), false, file);
      const extraction = path.join(root, "extracted");
      await mkdir(extraction);
      await execFileAsync("tar", ["-xzf", path.join(root, archiveRelative), "-C", extraction]);
      for (const file of files.filter((file) => !file.endsWith("/"))) {
        assert.equal((await readFile(path.join(extraction, file), "utf8")).includes("PRIVATE_FIXTURE_ONLY"), false, file);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("não segue symlinks nem hard links em arquivos, diretórios ou workflows", async () => {
    const root = await fixture();
    try {
      await put(root, "private-fixture/config.json", "PRIVATE_FIXTURE_ONLY");
      await put(root, "private-fixture/ci.yml", "PRIVATE_FIXTURE_ONLY");
      await symlink(path.join(root, "private-fixture/config.json"), path.join(root, "src/linked.json"));
      await symlink(path.join(root, "private-fixture"), path.join(root, "docs"));
      await symlink(path.join(root, "private-fixture"), path.join(root, ".github"));
      await link(path.join(root, "private-fixture/config.json"), path.join(root, "test/hardlinked.json"));
      const files = await pack(root);
      for (const name of ["sonora/src/linked.json", "sonora/test/hardlinked.json", "sonora/docs/", "sonora/.github/"]) {
        assert.equal(files.includes(name), false, name);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falha sem substituir pacote anterior quando falta arquivo obrigatório", async () => {
    const root = await fixture();
    try {
      await put(root, archiveRelative, "PREVIOUS_ARCHIVE");
      await rm(path.join(root, ".env.example"));
      await assert.rejects(() => pack(root), /Arquivos públicos obrigatórios ausentes ou inseguros/);
      assert.equal(await readFile(path.join(root, archiveRelative), "utf8"), "PREVIOUS_ARCHIVE");
      assert.deepEqual(await readdir(path.join(root, "release")), ["sonora-public.tar.gz"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recusa release simbólico sem gravar no destino externo", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "sonora-public-outside-"));
    try {
      await symlink(outside, path.join(root, "release"));
      await assert.rejects(() => pack(root), /release deve ser uma pasta real/);
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("ignora opções externas de tar/gzip que alterariam o conteúdo aprovado", async () => {
    const root = await fixture();
    try {
      const files = await pack(root, { ...process.env, TAR_OPTIONS: "--exclude=sonora/README.md", GZIP: "--invalid-fixture" });
      assert.ok(files.includes("sonora/README.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
