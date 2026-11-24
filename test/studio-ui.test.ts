import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createContext, runInContext } from "node:vm";

function functionSource(source: string, name: string): string {
  const match = source.match(new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, "m"));
  assert.ok(match, `Missing function ${name}`);
  const end = source.indexOf(`\n${match[1]}}`, match.index!);
  assert.ok(end > match.index!);
  return source.slice(match.index!, end + match[1]!.length + 2);
}

class NodeDouble {
  children: NodeDouble[] = [];
  parent: NodeDouble | null = null;
  dataset: Record<string, string> = {};
  value = "";
  hidden = false;
  disabled = false;
  replacements = 0;
  insertions = 0;
  private text = "";
  readonly attributes: Record<string, string> = {};
  readonly listeners = new Map<string, () => unknown>();
  get textContent() { return this.text; }
  set textContent(value: string) { this.text = value; for (const node of this.children) node.parent = null; this.children = []; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, callback: () => unknown) { this.listeners.set(name, callback); }
  append(...nodes: NodeDouble[]) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node: NodeDouble, before: NodeDouble | null) {
    node.remove(); this.insertions++;
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node); node.parent = this;
  }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  replaceChildren(...nodes: NodeDouble[]) { this.replacements++; this.textContent = ""; this.append(...nodes); }
}

async function fixture() {
  const source = await readFile(new URL("../public/studio.js", import.meta.url), "utf8");
  const elements = new Map<string, NodeDouble>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new NodeDouble()); return elements.get(id)!; };
  const document = { createElement: () => new NodeDouble(), activeElement: null as NodeDouble | null };
  const controls: unknown[] = [];
  let permissionChecks = 0;
  const context = createContext({
    $, document, layerRows: new Map(),
    label: (text: string) => Object.assign(new NodeDouble(), { textContent: text }),
    row: (...nodes: NodeDouble[]) => { const node = new NodeDouble(); node.append(...nodes); return node; },
    button: (_text: string, callback: () => unknown) => { const node = new NodeDouble(); node.addEventListener("click", callback); return node; },
    control: (action: unknown) => controls.push(action),
    Option: class extends NodeDouble { constructor(title: string, value: string) { super(); this.value = value; this.textContent = title; } },
    loaded: true, appState: { access: { authenticated: true, principal: { role: "owner" } }, library: [], playlists: [] },
    data: { scenes: [], folders: [], duplicates: [], trash: [] }, activeSession: () => null,
    sceneSelection: "", recovery: new NodeDouble(), shortcuts: {},
    window: { sonoraSharing: { permissions: () => { permissionChecks++; } } },
  });
  function $(id: string) { return get(id); }
  runInContext(["validShortcuts", "updateSelect", "renderLayers", "render"].map(name => functionSource(source, name)).join("\n"), context);
  return { get, document, controls, run: (code: string) => runInContext(code, context), checks: () => permissionChecks };
}

describe("Studio UI regressions", () => {
  it("atalhos salvos inválidos não derrubam a interface", async () => {
    const test = await fixture();
    for (const value of ["null", '"text"', "[]", "42"]) assert.equal(Object.keys(test.run(`validShortcuts(${value})`)).length, 0);
    const result = test.run('validShortcuts({ a: "A", b: "4", c: null, d: {}, e: "ctrl+a", f: "" })');
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { a: "A", b: "4" });
  });
  it("eventos de estado não recriam nem mudam o volume que está sendo ajustado", async () => {
    const test = await fixture();
    test.run('renderLayers("environment-list", [{ playbackId: "rain", title: "Chuva", volume: 70 }])');
    const list = test.get("environment-list"); const row = list.children[0]!; const slider = row.children[2]!;
    test.document.activeElement = slider; slider.value = "31";
    const insertions = list.insertions;
    test.run('renderLayers("environment-list", [{ playbackId: "rain", title: "Chuva leve", volume: 90 }])');
    assert.equal(list.children[0], row); assert.equal(row.children[2], slider);
    assert.equal(slider.value, "31"); assert.equal(list.insertions, insertions);
    assert.equal(slider.attributes["aria-label"], "Volume de Chuva leve");
    slider.listeners.get("change")!();
    assert.deepEqual(JSON.parse(JSON.stringify(test.controls[0])), { action: "layerVolume", playbackId: "rain", value: 31 });
    test.document.activeElement = null;
    test.run('renderLayers("environment-list", [{ playbackId: "rain", title: "Chuva", volume: 90 }])');
    assert.equal(slider.value, "90");
  });
  it("remover outro ambiente não desloca o controle em foco; lista vazia remove controles", async () => {
    const test = await fixture();
    test.run('renderLayers("environment-list", [{ playbackId: "a", title: "A", volume: 50 }, { playbackId: "b", title: "B", volume: 50 }])');
    const list = test.get("environment-list"); const remaining = list.children[1]!;
    test.document.activeElement = remaining.children[2]!; const insertions = list.insertions;
    test.run('renderLayers("environment-list", [{ playbackId: "b", title: "B", volume: 50 }])');
    assert.equal(list.children[0], remaining); assert.equal(list.insertions, insertions);
    test.run('renderLayers("environment-list", [])');
    assert.equal(list.children.length, 0); assert.equal(list.textContent, "Nenhum áudio neste grupo.");
  });
  it("seletores preservam escolha e não recriam centenas de opções a cada estado", async () => {
    const test = await fixture();
    test.run('updateSelect($("environment-track"), [["a", "A"], ["b", "B"]], "b")');
    const select = test.get("environment-track"); assert.equal(select.value, "b");
    test.run('updateSelect($("environment-track"), [["a", "A"], ["b", "B"]])');
    assert.equal(select.replacements, 1); assert.equal(select.value, "b");
    test.run('updateSelect($("environment-track"), [["a", "A"], ["b", "Novo título"]])');
    assert.equal(select.replacements, 2); assert.equal(select.children[1]!.textContent, "Novo título");
  });
  it("refresh direto da mesa também reaplica permissões dos controles", async () => {
    const test = await fixture(); test.run("render()"); assert.equal(test.checks(), 1);
  });
  it("texto do destaque usa a cor com maior contraste, inclusive no laranja padrão", async () => {
    const source = await readFile(new URL("../public/preferences.js", import.meta.url), "utf8");
    const context = createContext({}); runInContext(functionSource(source, "accentTextColor"), context);
    assert.equal(runInContext('accentTextColor("#ff6b35")', context), "#000000");
    assert.equal(runInContext('accentTextColor("#101014")', context), "#ffffff");
    assert.equal(runInContext('accentTextColor("#ffffff")', context), "#000000");
  });
  it("menu Mais não é cortado pelo contêiner real da biblioteca", async () => {
    const css = await readFile(new URL("../public/studio.css", import.meta.url), "utf8");
    assert.match(css, /#music-list\s*\{\s*overflow:\s*visible/);
  });
  it("layout móvel do menu e soundboard prevalece após as regras desktop", async () => {
    const css = await readFile(new URL("../public/studio.css", import.meta.url), "utf8");
    const mobile = css.slice(css.indexOf("@media (max-width: 700px)"));
    assert.match(mobile, /\.track-menu-content\s*\{\s*position:\s*fixed/);
    assert.match(mobile, /\.studio-soundboard\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.ok(css.indexOf("@media (max-width: 700px)") > css.indexOf(".track-menu-content { position: absolute"));
  });
});
