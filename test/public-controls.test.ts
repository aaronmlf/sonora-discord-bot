import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createContext, runInContext, Script } from "node:vm";

// Execute the shipped render/action functions without a browser dependency.
// This is a focused DOM-double test, not a layout or real-browser test.
class ElementDouble {
  children: ElementDouble[] = [];
  hidden = false;
  disabled = false;
  value = "";
  textContent = "";
  innerHTML = "";
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners = new Map<string, Array<() => unknown>>();
  queries = new Map<string, ElementDouble>();
  classes = new Set<string>();
  classList = { toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  constructor(readonly tagName = "div") {}
  get childElementCount() { return this.children.length; }
  append(...items: ElementDouble[]) { this.children.push(...items); }
  replaceChildren(...items: ElementDouble[]) { this.children = items; }
  add(item: ElementDouble) { this.append(item); }
  setAttribute(_name: string, _value: string) {}
  addEventListener(name: string, action: () => unknown) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), action]); }
  async click() { if (!this.disabled) await Promise.all((this.listeners.get("click") ?? []).map(action => action())); }
  querySelector(selector: string): ElementDouble | null {
    const action = selector.match(/^\[data-action="(.+)"\]$/)?.[1];
    if (action ? !this.innerHTML.includes(`data-action="${action}"`) : !this.innerHTML.includes(`class="${selector.slice(1)}"`)) return null;
    if (!this.queries.has(selector)) this.queries.set(selector, new ElementDouble("button"));
    return this.queries.get(selector)!;
  }
}

function functionSource(source: string, name: string): string {
  const match = source.match(new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, "m"));
  assert.ok(match, `Missing function ${name}`);
  const start = match.index!;
  const end = source.indexOf(`\n${match[1]}}`, start);
  assert.ok(end > start, `Missing closing brace for ${name}`);
  return source.slice(start, end + match[1]!.length + 2);
}

async function fixture() {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const sharing = await readFile(new URL("../public/sharing.js", import.meta.url), "utf8");
  const names = ["renderLibrary", "updateSourceControls", "renderVolume", "trackFolder", "tracksForCategory", "folderContains", "childFolders", "setFolder", "ensureFolderSelection", "renderFolderNavigation", "breadcrumbButton", "breadcrumbSeparator", "folderCard", "setFolderActionState", "renderMusicFolders", "musicTrackRow", "renderEffectFolders", "effectTrackCard", "renderPlaylistFilterControls", "ensurePlaylistFilter", "playlistFilterTrackIds", "formatDuration", "formatLongDuration", "escapeHtml", "enqueue", "playEffect", "renderPlaybackAvailability", "renderPlayer", "renderProgress", "statusLabel", "loopLabel", "friendlyPlaybackError"];
  const elements: Record<string, ElementDouble> = new Proxy({}, { get: (target: Record<string, ElementDouble>, key: string) => target[key] ??= new ElementDouble() });
  const appState = { bot: { configured: true, connected: true, lastError: null as string | null },
    access: { principal: { role: "owner", profile: "full", guildIds: null as string[] | null } },
    library: [
      { id: "music", source: "local", category: "music", title: "Tema", relativePath: "music/Campanha/tema.mp3" },
      { id: "effect", source: "local", category: "effect", title: "Trovão", relativePath: "effects/Clima/trovao.mp3" },
    ], playlists: [] as Array<{ id: string; name: string; items: Array<{ trackId: string }> }>,
    musicFolder: "", effectFolder: "", filterPlaylistId: "",
  };
  const session = { guildId: "111", guildName: "Mesa", voiceChannelId: "voice", activeEffects: [] };
  const requests: Array<{ url: string; body: unknown }> = [];
  const toasts: string[] = [];
  const body = new ElementDouble();
  const context = createContext({ appState, elements, ROOT_FILES_FOLDER: ".", window: {}, pendingVolumes: new Map(), selectedPlaylist: () => null,
    document: { createElement: (tag: string) => new ElementDouble(tag), body, querySelectorAll: () => [] },
    sessionStorage: { setItem: () => {}, removeItem: () => {} }, activeSession: () => session,
    Option: class extends ElementDouble { constructor(text: string, value: string) { super("option"); this.textContent = text; this.value = value; } },
    api: async (url: string, options: { body: string }) => { requests.push({ url, body: JSON.parse(options.body) }); return {}; },
    showToast: (message: string) => toasts.push(message), renderQueue: () => {}, $: (id: string) => elements[id], maintenance: new ElementDouble(),
  });
  runInContext(names.map(name => functionSource(app, name)).join("\n") + "\n" + functionSource(sharing, "permissions"), context);
  return { appState, session, elements, requests, toasts, body, run: (code: string) => runInContext(code, context) };
}

describe("Public playback controls", () => {
  it("todos os scripts da GUI têm sintaxe válida", async () => {
    for (const name of ["app", "sharing", "studio", "preferences"]) {
      const source = await readFile(new URL(`../public/${name}.js`, import.meta.url), "utf8");
      assert.doesNotThrow(() => new Script(source, { filename: `${name}.js` }));
    }
  });
  it("abrir pasta exibe + Fila e envia a faixa para o servidor selecionado", async () => {
    const test = await fixture(); test.run("renderLibrary()");
    assert.equal(test.elements["music-folder-list"]!.children.length, 1);
    await test.elements["music-folder-list"]!.children[0]!.click();
    assert.equal(test.appState.musicFolder, "Campanha");
    assert.equal(test.elements["music-list"]!.children.length, 1);
    const row = test.elements["music-list"]!.children[0]!;
    const button = row.querySelector('[data-action="queue"]'); assert.ok(button); assert.equal(button.disabled, false);
    await button.click();
    assert.equal(test.requests[0]!.url, "/api/sessions/111/queue");
    assert.deepEqual(JSON.parse(JSON.stringify(test.requests[0]!.body)), { trackId: "music", position: "end" });
    assert.equal(test.elements["music-folder-play-all"]!.dataset.trackIds, "music");
    assert.equal(test.elements["music-folder-shuffle"]!.disabled, false);
  });
  it("abrir pasta de efeitos permite disparar sobre a música", async () => {
    const test = await fixture(); test.run("renderLibrary()");
    await test.elements["effect-folder-list"]!.children[0]!.click();
    const button = test.elements["effect-grid"]!.children[0]!.querySelector(".effect-play"); assert.ok(button);
    await button.click();
    assert.equal(test.requests[0]!.url, "/api/sessions/111/effects");
    assert.equal((test.requests[0]!.body as { trackId: string }).trackId, "effect");
  });
  it("sem call mantém + Fila visível, desabilitado, com instrução; mostra erro offline", async () => {
    const test = await fixture(); test.session.voiceChannelId = ""; test.run('setFolder("music", "Campanha"); renderPlaybackAvailability()');
    const button = test.elements["music-list"]!.children[0]!.querySelector('[data-action="queue"]'); assert.ok(button); assert.equal(button.disabled, true);
    assert.equal(test.elements["playback-availability"]!.hidden, false);
    assert.match(test.elements["playback-availability-copy"]!.textContent, /\/join ou \/play/);
    test.appState.bot.connected = false; test.appState.bot.lastError = "Sem conexão de teste"; test.run("renderPlaybackAvailability()");
    assert.match(test.elements["playback-availability-copy"]!.textContent, /Sem conexão de teste/);
    test.appState.bot.connected = true; test.session.voiceChannelId = "voice"; test.run("renderPlaybackAvailability()");
    assert.equal(test.elements["playback-availability"]!.hidden, true);
  });
  it("filtro de playlist não mostra músicas de outra seleção", async () => {
    const test = await fixture();
    test.appState.playlists = [{ id: "effects", name: "Efeitos", items: [{ trackId: "effect" }] }];
    test.appState.filterPlaylistId = "effects"; test.run("renderLibrary()");
    assert.equal(test.elements["music-folder-list"]!.children.length, 0);
    assert.equal(test.elements["effect-folder-list"]!.children.length, 1);
  });
  it("carregamento não aparece como tocando nem avança a duração da faixa", async () => {
    const test = await fixture();
    Object.assign(test.session, { status: "buffering", current: { ...test.appState.library[0], durationMs: 60000 },
      startedAt: "2020-01-01T00:00:00Z", pausedAt: "2020-01-01T00:00:10Z", upcoming: [],
      volume: 70, effectVolume: 100, repeatMode: "off" });
    test.run("renderPlayer()");
    assert.equal(test.elements["playback-label"]!.textContent, "CARREGANDO ÁUDIO…");
    assert.equal(test.elements["elapsed-time"]!.textContent, "0:10");
  });
  it("apenas o perfil efeitos oculta controles de fila, anfitrião e reprodução mantêm", async () => {
    const test = await fixture(); test.run("permissions()");
    assert.equal(test.body.classes.has("effects-only"), false);
    assert.equal(test.elements["external-form"]!.hidden, false);
    test.appState.access.principal = { role: "collaborator", profile: "effects", guildIds: ["111"] }; test.run("permissions()");
    assert.equal(test.body.classes.has("effects-only"), true);
    assert.equal(test.elements["external-form"]!.hidden, true);
    test.appState.access.principal.profile = "playback"; test.run("permissions()");
    assert.equal(test.body.classes.has("effects-only"), false);
    assert.equal(test.elements["external-form"]!.hidden, false);
    const css = await readFile(new URL("../public/sharing.css", import.meta.url), "utf8");
    assert.match(css, /\.effects-only \[data-action=queue\]/);
  });
});
