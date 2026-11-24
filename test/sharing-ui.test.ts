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

class ElementDouble {
  value = ""; checked = false; hidden = false; disabled = false; textContent = "";
  children: ElementDouble[] = []; dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  replacements = 0; click: () => unknown = () => {};
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  querySelectorAll(_query: string) { return this.children; }
  replaceChildren(...children: ElementDouble[]) { this.children = children; this.replacements++; }
}

async function fixture() {
  const source = await readFile(new URL("../public/sharing.js", import.meta.url), "utf8");
  const nodes = new Map<string, ElementDouble>();
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new ElementDouble()); return nodes.get(id)!; };
  let renders = 0; const statuses: string[] = [];
  const state = { access: { authenticated: true }, sessions: [{ guildId: "111", guildName: "Mesa" }] };
  const context = createContext({
    $: get, appState: state, profileHelp: { full: "Perfil completo" }, actions: [], sessionGeneration: 1,
    backupBusy: false, backupController: null, AbortController, syncBackupControls: () => {},
    backupStatus: (message: string) => statuses.push(message), renderActivity: () => { renders++; },
    button: (text: string, callback: () => unknown) => Object.assign(new ElementDouble(), { textContent: text, click: callback }),
  });
  runInContext(["readPolicy", "markSuggestions", "syncPolicy", "suggestions", "runBackup", "activity"].map(name => functionSource(source, name)).join("\n"), context);
  get("invite-profile").value = "full";
  return { get, state, statuses, renders: () => renders, run: (code: string) => runInContext(code, context), context };
}

describe("Sharing UI regressions", () => {
  it("restrição oculta IDs desativados e valida seleção vazia ou inválida", async () => {
    const test = await fixture(); test.run('syncPolicy("invite")');
    assert.equal(test.get("invite-servers").hidden, true);
    assert.equal(test.get("invite-guilds").disabled, true);
    test.get("invite-restricted").checked = true; test.run('syncPolicy("invite")');
    assert.equal(test.get("invite-servers").hidden, false);
    assert.throws(() => test.run('readPolicy("invite")'), /ao menos um/);
    test.get("invite-guilds").value = "111, 111 222";
    assert.deepEqual(JSON.parse(JSON.stringify(test.run('readPolicy("invite")'))), { profile: "full", guildIds: ["111", "222"] });
    test.get("invite-guilds").value = "invalid";
    assert.throws(() => test.run('readPolicy("invite")'), /numéricos/);
  });
  it("servidores podem ser selecionados e removidos sem recriar botões a cada estado", async () => {
    const test = await fixture(); test.get("invite-restricted").checked = true;
    test.run('suggestions("invite")');
    const list = test.get("invite-suggestions"); const button = list.children[0]!;
    button.click(); assert.equal(test.get("invite-guilds").value, "111"); assert.equal(button.attributes["aria-pressed"], "true");
    test.run('suggestions("invite")'); assert.equal(list.replacements, 1); assert.equal(list.children[0], button);
    button.click(); assert.equal(test.get("invite-guilds").value, ""); assert.equal(button.attributes["aria-pressed"], "false");
  });
  it("eventos atrasados não repovoam o histórico após logout", async () => {
    const test = await fixture(); test.run('activity({ id: "a", actor: "Pessoa" })'); assert.equal(test.renders(), 1);
    test.state.access.authenticated = false; test.run('activity({ id: "b", actor: "Outra" })');
    assert.equal(test.renders(), 1); assert.equal(test.run("actions.length"), 1);
  });
  it("falha de um backup antigo não altera o status nem desbloqueia a nova sessão", async () => {
    const test = await fixture();
    let reject!: (error: Error) => void;
    test.context.pendingBackup = new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
    const pending = test.run("runBackup(() => pendingBackup)") as Promise<void>;
    assert.equal(test.run("backupBusy"), true);
    test.run("sessionGeneration++; backupBusy = true"); reject(new Error("Dados da sessão antiga")); await pending;
    assert.deepEqual(test.statuses, []); assert.equal(test.run("backupBusy"), true);
  });
});
