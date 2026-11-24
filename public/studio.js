(() => {
  const $ = id => document.getElementById(id);
  const data = { scenes: [], folders: [], trash: [], duplicates: [] };
  const filters = { music: { favorites: false, tag: "", sort: "name" }, effect: { favorites: false, tag: "", sort: "name", search: "" } };
  function validShortcuts(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, key]) => id && typeof key === "string" && /^[A-Z0-9]$/.test(key)));
  }
  let shortcuts = {};
  try { shortcuts = validShortcuts(JSON.parse(localStorage.getItem("sonora:shortcuts") || "{}")); } catch { /* Invalid preferences are safely reset. */ }
  let refreshing = false;
  let loaded = false;
  let sceneSelection = "";
  let generation = 0;
  const button = (label, action, disabled = false) => {
    const element = document.createElement("button"); element.type = "button"; element.className = "secondary-button";
    element.textContent = label; element.disabled = disabled;
    element.addEventListener("click", async () => {
      if (element.dataset.busy) return;
      element.dataset.busy = "true"; const wasDisabled = element.disabled; element.disabled = true;
      try { await action(); } catch (error) { showToast(error.message, true); }
      finally { delete element.dataset.busy; element.disabled = wasDisabled; window.sonoraSharing?.permissions(); }
    }); return element;
  };
  const row = (...children) => { const el = document.createElement("div"); el.className = "studio-row"; el.append(...children); return el; };
  const label = text => { const el = document.createElement("span"); el.textContent = text; return el; };
  const json = (url, body, method = "POST") => api(url, { method, body: JSON.stringify(body) });
  function updateSelect(select, choices, selected = select.value) {
    const signature = JSON.stringify(choices);
    if (select.dataset.optionsSignature !== signature) {
      select.replaceChildren(...choices.map(([value, title]) => new Option(title, value)));
      select.dataset.optionsSignature = signature;
    }
    if (choices.some(([value]) => value === selected)) select.value = selected;
  }
  const layerRows = new Map();
  function renderLayers(containerId, layers) {
    const container = $(containerId);
    const existing = layerRows.get(containerId) || new Map();
    const next = new Map();
    const environment = containerId === "environment-list";
    for (const layer of layers) {
      let item = existing.get(layer.playbackId);
      if (!item) {
        const title = label(layer.title);
        const element = row(title, button("Parar", () => control({ action: "stopLayer", playbackId: layer.playbackId })));
        const volume = environment ? document.createElement("input") : null;
        if (volume) {
          volume.type = "range"; volume.min = "0"; volume.max = "100";
          volume.addEventListener("change", () => control({ action: "layerVolume", playbackId: layer.playbackId, value: Number(volume.value) }));
          element.append(volume);
        }
        item = { element, title, volume };
      }
      item.title.textContent = layer.title;
      if (item.volume) {
        item.volume.setAttribute("aria-label", `Volume de ${layer.title}`);
        if (document.activeElement !== item.volume) item.volume.value = String(layer.volume);
      }
      next.set(layer.playbackId, item);
    }
    if (!next.size) container.textContent = "Nenhum áudio neste grupo.";
    else {
      // Keep existing range inputs in place while an SSE update arrives, so
      // dragging/focusing a volume control does not reset or lose its change.
      if (!container.children.length) container.textContent = "";
      const nodes = [...next.values()].map(item => item.element);
      for (const node of [...container.children]) if (!nodes.includes(node)) node.remove();
      for (const [index, node] of nodes.entries()) if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
    }
    layerRows.set(containerId, next);
  }
  async function control(body) {
    const session = activeSession();
    if (!session) { showToast("Chame o bot pelo Discord primeiro.", true); return; }
    try { await json(`/api/sessions/${session.guildId}/studio`, body); }
    catch (error) { showToast(error.message, true); }
  }
  async function refresh() {
    if (refreshing || !appState.access.authenticated) return;
    refreshing = true;
    const currentGeneration = generation;
    try { const result = await api("/api/studio"); if (currentGeneration !== generation) return; Object.assign(data, result); loaded = true; renderLibrary(); render(); }
    catch (error) { showToast(error.message, true); }
    finally { refreshing = false; }
  }
  const folderPath = category => `${category === "music" ? "music" : "effects"}${appState[`${category}Folder`] && appState[`${category}Folder`] !== "." ? `/${appState[`${category}Folder`]}` : ""}`;
  function addFilters(category) {
    const toolbar = document.createElement("div"); toolbar.className = "studio-toolbar";
    toolbar.innerHTML = `${category === "effect" ? '<label>Buscar efeitos<input type="search" data-filter="search" placeholder="Título, pasta ou etiqueta"></label>' : ""}
      <label class="studio-check"><input type="checkbox" data-filter="favorites"> Só favoritos</label>
      <label>Etiqueta<input type="search" data-filter="tag" placeholder="Combate, suspense…"></label>
      <label>Ordenar<select data-filter="sort"><option value="name">Nome</option><option value="duration">Duração</option><option value="date">Adicionados recentemente</option></select></label>`;
    for (const input of toolbar.querySelectorAll("[data-filter]")) input.addEventListener("input", () => {
      filters[category][input.dataset.filter] = input.type === "checkbox" ? input.checked : input.value; renderLibrary();
    });
    toolbar.append(button("Nova pasta", async () => {
      const name = prompt("Nome da nova pasta (dentro da pasta atual):"); if (!name) return;
      await json("/api/studio/library", { action: "folder", folder: `${folderPath(category)}/${name.trim()}` }); await refresh();
    }));
    document.querySelector(`#${category === "music" ? "library" : "effects"}-view .folder-toolbar`).before(toolbar);
  }
  function filter(tracks, category) {
    const f = filters[category]; const normalize = value => String(value).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
    return tracks.filter(track => (!f.favorites || track.favorite) && (!f.tag || (track.tags || []).some(tag => normalize(tag).includes(normalize(f.tag)))) && (!f.search || normalize([track.title, track.artist, track.relativePath, ...(track.tags || [])].join(" ")).includes(normalize(f.search))))
      .sort((a, b) => f.sort === "duration" ? (a.durationMs || 0) - (b.durationMs || 0) : f.sort === "date" ? Date.parse(b.addedAt || b.modifiedAt) - Date.parse(a.addedAt || a.modifiedAt) : a.title.localeCompare(b.title, "pt-BR"));
  }
  function childFolders(category, current) {
    if (current === "." || appState.filterPlaylistId || filters[category].favorites || filters[category].tag) return [];
    const root = category === "music" ? "music/" : "effects/";
    const prefix = current ? `${current}/` : "";
    return data.folders.filter(folder => folder.startsWith(root + prefix)).map(folder => folder.slice(root.length)).filter(folder => folder !== current && folder.slice(prefix.length) && !folder.slice(prefix.length).includes("/"));
  }
  const preview = document.createElement("audio"); preview.controls = true; preview.preload = "none";
  const previewPanel = document.createElement("aside"); previewPanel.className = "local-preview panel"; previewPanel.hidden = true;
  const previewTitle = label(""); previewPanel.append(previewTitle, preview, button("Fechar prévia", () => { preview.pause(); preview.removeAttribute("src"); preview.load(); previewPanel.hidden = true; })); document.body.append(previewPanel);
  async function previewTrack(track) {
    preview.pause(); preview.src = `/api/library/${encodeURIComponent(track.id)}/preview`;
    previewTitle.textContent = `Só neste navegador · ${track.title}`; previewPanel.hidden = false;
    await preview.play();
  }
  preview.addEventListener("error", () => showToast("Não foi possível ouvir este formato no navegador. A reprodução no Discord pode continuar disponível.", true));
  function trackActions(container, track) {
    const details = document.createElement("details"); details.className = "track-menu";
    const summary = document.createElement("summary"); summary.textContent = track.favorite ? "★ Mais" : "Mais"; summary.setAttribute("aria-label", `Mais ações para ${track.title}`); details.append(summary);
    details.addEventListener("toggle", () => {
      if (details.open) for (const other of document.querySelectorAll(".track-menu[open]")) if (other !== details) other.open = false;
    });
    const menu = document.createElement("div"); menu.className = "track-menu-content";
    menu.append(
      button("Ouvir só aqui", () => previewTrack(track)),
      button("Tocar agora", () => control({ action: "playNow", trackId: track.id }), !activeSession()?.voiceChannelId),
      button("Adicionar como próxima", () => enqueue(track.id, "next"), !activeSession()?.voiceChannelId),
      button(track.favorite ? "Remover favorito" : "Marcar favorito", async () => { await json(`/api/library/${track.id}`, { favorite: !track.favorite }, "PATCH"); }),
      button("Editar etiquetas", async () => {
        const value = prompt("Etiquetas separadas por vírgula:", (track.tags || []).join(", ")); if (value === null) return;
        await json(`/api/library/${track.id}`, { tags: value.split(",").map(s => s.trim()).filter(Boolean) }, "PATCH");
      }),
      button("Mover para pasta", () => openMove(track)),
    );
    if (track.category === "effect") menu.append(button("Configurar atalho", () => {
      const value = prompt("Tecla para este efeito (A–Z ou 0–9). Deixe vazio para remover:", shortcuts[track.id] || ""); if (value === null) return;
      const key = value.trim().toUpperCase(); if (key && !/^[A-Z0-9]$/.test(key)) throw new Error("Escolha uma letra ou um número.");
      if (key) for (const id of Object.keys(shortcuts)) if (shortcuts[id] === key) delete shortcuts[id];
      if (key) shortcuts[track.id] = key; else delete shortcuts[track.id];
      try { localStorage.setItem("sonora:shortcuts", JSON.stringify(shortcuts)); showToast("Atalho salvo neste navegador."); }
      catch { showToast("Atalho aplicado nesta sessão; o navegador não permitiu salvá-lo."); }
      render();
    }));
    details.append(menu); container.append(details);
  }
  const moveDialog = document.createElement("dialog"); moveDialog.innerHTML = '<form method="dialog"><h2>Mover áudio</h2><label>Pasta de destino<select id="studio-move-folder"></select></label><div id="studio-move-buttons" class="studio-row"></div></form>'; document.body.append(moveDialog);
  function openMove(track) {
    $("studio-move-folder").replaceChildren(...data.folders.map(folder => new Option(folder, folder)));
    $("studio-move-folder").value = track.relativePath.split("/").slice(0, -1).join("/");
    $("studio-move-buttons").replaceChildren(button("Cancelar", () => moveDialog.close()), button("Mover", async () => {
      await json("/api/studio/library", { action: "move", trackId: track.id, folder: $("studio-move-folder").value }); moveDialog.close(); await refresh();
    })); moveDialog.showModal();
  }
  async function upload(files) {
    const category = appState.uploadCategory;
    const folder = folderPath(category).split("/").slice(1).join("/");
    let done = 0; let failed = 0;
    for (const file of files) {
      showToast(`Enviando ${done + failed + 1}/${files.length}: ${file.name}`);
      const form = new FormData(); form.append("file", file);
      try { const result = await api(`/api/library/upload?category=${category}&folder=${encodeURIComponent(folder)}`, { method: "POST", body: form }); appState.library = result.tracks; done++; }
      catch (error) { failed++; showToast(`${file.name}: ${error.message}`, true); }
    }
    elements["file-input"].value = ""; renderLibrary(); await refresh();
    showToast(`${done} áudio(s) adicionado(s)${failed ? `; ${failed} não enviado(s)` : ""}.`, failed > 0);
  }

  document.querySelector(".main-nav").append(Object.assign(document.createElement("a"), { className: "nav-item", href: "#studio", innerHTML: '<span aria-hidden="true">♫</span> Mesa RPG' }));
  document.querySelector('.main-nav a[href="#studio"]').dataset.view = "studio";
  const panel = document.createElement("section"); panel.id = "studio-view"; panel.className = "view"; panel.dataset.viewPanel = "studio";
  panel.innerHTML = `<div class="library-heading"><div><p class="eyebrow">CENAS E AMBIENTES</p><h2>Mesa RPG</h2></div><div class="studio-row"><button id="scene-new" class="primary-button" type="button">Nova cena</button><button id="presentation-toggle" class="secondary-button" type="button">Modo apresentação</button></div></div>
    <p id="studio-warning" role="status"></p>
    <div class="studio-grid"><section class="panel studio-section"><h3>Cenas salvas</h3><p>Ativar substitui música e ambientes. Os efeitos em andamento continuam.</p><div id="scene-list"></div></section>
    <section class="panel studio-section"><h3>Ambientes em loop</h3><label>Volume dos ambientes<input id="environment-volume" type="range" min="0" max="100" value="70"><output id="environment-output">70%</output></label><div class="studio-row"><select id="environment-track" aria-label="Áudio do ambiente"></select><button id="environment-add" type="button" class="secondary-button">+ Ambiente</button></div><div id="environment-list"></div><label class="studio-check"><input id="ducking" type="checkbox"> Reduzir música durante efeitos</label></section></div>
    <section class="panel studio-section"><h3>Soundboard da cena</h3><select id="soundboard-scene" aria-label="Escolher soundboard"></select><div id="scene-effects" class="studio-soundboard"></div><h3>Efeitos em andamento</h3><div id="live-effects"></div><button id="effects-stop-all" class="secondary-button" type="button">Parar todos os efeitos</button></section>
    <details class="panel studio-section"><summary>Lixeira e duplicados</summary><p>A lixeira mantém os arquivos até o anfitrião esvaziá-la. Duplicados são agrupados por conteúdo; nada é apagado automaticamente.</p><div id="trash-list"></div><button id="trash-purge" class="danger-button" type="button">Esvaziar lixeira permanentemente</button><h3>Arquivos com o mesmo conteúdo</h3><div id="duplicate-list"></div></details>`;
  document.querySelector("main").append(panel);
  const queueTools = document.createElement("div"); queueTools.className = "studio-toolbar";
  queueTools.append(button("Embaralhar próximas", () => control({ action: "shuffle" })), button("Salvar fila como playlist", () => { const name = prompt("Nome da playlist (apenas áudios locais):"); if (name) return control({ action: "saveQueue", name }); }));
  const recovery = document.createElement("div"); recovery.id = "queue-recovery"; recovery.className = "studio-row"; recovery.hidden = true;
  recovery.append(label("Há uma fila da execução anterior. Ela será retomada do início da faixa."), button("Restaurar", () => control({ action: "restoreQueue" })), button("Descartar", () => { if (confirm("Descartar a fila salva da execução anterior?")) return control({ action: "discardQueue" }); }));
  elements["queue-list"].before(queueTools, recovery);
  $("environment-volume").addEventListener("change", event => control({ action: "environmentVolume", value: Number(event.target.value) }));
  $("environment-volume").addEventListener("input", event => { $("environment-output").textContent = `${event.target.value}%`; });
  $("environment-add").addEventListener("click", () => control({ action: "environment", trackId: $("environment-track").value, volume: 100 }));
  $("ducking").addEventListener("change", event => control({ action: "ducking", value: event.target.checked }));
  $("effects-stop-all").addEventListener("click", () => control({ action: "stopEffects" }));
  $("trash-purge").addEventListener("click", async () => {
    if (!confirm("Apagar permanentemente TODOS os arquivos da lixeira? Esta ação não pode ser desfeita.")) return;
    try { await json("/api/studio/library", { action: "purge" }); await refresh(); } catch (error) { showToast(error.message, true); }
  });
  $("presentation-toggle").addEventListener("click", () => {
    const active = document.body.classList.toggle("presentation-mode"); $("presentation-toggle").textContent = active ? "Sair da apresentação" : "Modo apresentação";
  });
  $("soundboard-scene").addEventListener("change", event => { sceneSelection = event.target.value; render(); });
  const sceneDialog = document.createElement("dialog"); sceneDialog.className = "scene-dialog";
  sceneDialog.innerHTML = `<form id="scene-form"><h2>Configurar cena</h2><input id="scene-id" type="hidden"><label>Nome<input id="scene-name" required maxlength="100"></label><label>Playlist musical<select id="scene-playlist"></select></label>
    <fieldset><legend>Até três ambientes em loop</legend>${[0, 1, 2].map(i => `<div class="studio-row"><select id="scene-env-${i}" aria-label="Ambiente ${i + 1}"></select><label>Volume<input id="scene-env-volume-${i}" type="number" min="0" max="100" value="100" required></label></div>`).join("")}</fieldset>
    <div class="studio-row">${[["music", "Música", 100], ["environment", "Ambientes", 100], ["effect", "Efeitos", 150]].map(([id, name, max]) => `<label>${name} (%)<input id="scene-${id}-volume" type="number" min="0" max="${max}" required></label>`).join("")}</div>
    <label>Transição (segundos)<input id="scene-transition" type="number" min="0" max="10" step="0.1" value="2" required></label><label class="studio-check"><input id="scene-ducking" type="checkbox"> Reduzir música durante efeitos</label>
    <fieldset><legend>Efeitos favoritos desta cena</legend><div id="scene-effect-choices" class="scene-choices"></div></fieldset><div class="studio-row"><button class="primary-button" type="submit">Salvar cena</button><button id="scene-cancel" class="secondary-button" type="button">Cancelar</button></div></form>`;
  document.body.append(sceneDialog);
  $("scene-cancel").addEventListener("click", () => sceneDialog.close());
  function openScene(scene = null) {
    $("scene-id").value = scene?.id || ""; $("scene-name").value = scene?.name || "";
    $("scene-playlist").replaceChildren(new Option("Sem música", ""), ...appState.playlists.map(item => new Option(item.name, item.id)));
    $("scene-playlist").value = scene?.playlistId || "";
    for (let i = 0; i < 3; i++) {
      $(`scene-env-${i}`).replaceChildren(new Option("Sem ambiente", ""), ...appState.library.map(track => new Option(track.title, track.id)));
      $(`scene-env-${i}`).value = scene?.environments[i]?.trackId || ""; $(`scene-env-volume-${i}`).value = scene?.environments[i]?.volume ?? 100;
    }
    for (const type of ["music", "environment", "effect"]) $(`scene-${type}-volume`).value = scene?.[`${type}Volume`] ?? (type === "effect" ? 100 : 70);
    $("scene-transition").value = (scene?.transitionMs ?? 2000) / 1000; $("scene-ducking").checked = scene?.ducking || false;
    $("scene-effect-choices").replaceChildren(...appState.library.filter(t => t.category === "effect").map(track => {
      const el = document.createElement("label"); el.className = "studio-check"; const input = document.createElement("input"); input.type = "checkbox"; input.value = track.id; input.checked = scene?.effectIds.includes(track.id) || false; el.append(input, label(track.title)); return el;
    })); sceneDialog.showModal();
  }
  $("scene-new").addEventListener("click", () => openScene());
  $("scene-form").addEventListener("submit", async event => {
    event.preventDefault();
    const scene = { name: $("scene-name").value, playlistId: $("scene-playlist").value || null, environments: [0, 1, 2].filter(i => $(`scene-env-${i}`).value).map(i => ({ trackId: $(`scene-env-${i}`).value, volume: Number($(`scene-env-volume-${i}`).value) })), effectIds: [...$("scene-effect-choices").querySelectorAll("input:checked")].map(input => input.value), transitionMs: Math.round(Number($("scene-transition").value) * 1000), ducking: $("scene-ducking").checked };
    for (const type of ["music", "environment", "effect"]) scene[`${type}Volume`] = Number($(`scene-${type}-volume`).value);
    try { await json("/api/scenes", { ...($("scene-id").value ? { id: $("scene-id").value } : {}), scene }); sceneDialog.close(); await refresh(); showToast("Cena salva."); }
    catch (error) { showToast(error.message, true); }
  });
  function render() {
    if (!loaded && appState.access.authenticated) void refresh();
    const session = activeSession();
    $("studio-warning").textContent = data.persistenceError ? "Não foi possível salvar a recuperação da fila. Verifique o espaço e as permissões da pasta de dados." : !session?.voiceChannelId ? "Chame o bot pelo Discord para transmitir áudio. A prévia local funciona sem call." : "";
    recovery.hidden = !session?.recoveryAvailable;
    if (document.activeElement !== $("environment-volume")) $("environment-volume").value = session?.environmentVolume ?? 70;
    $("environment-output").textContent = `${$("environment-volume").value}%`; $("ducking").checked = session?.ducking || false;
    updateSelect($("environment-track"), appState.library.map(track => [track.id, track.title]));
    $("environment-add").disabled = !session?.voiceChannelId || !appState.library.length || (session.environments?.length || 0) >= 3;
    $("scene-list").replaceChildren(...data.scenes.map(scene => row(label(scene.name), button("Ativar", () => { sceneSelection = scene.id; return control({ action: "scene", sceneId: scene.id }); }, !session?.voiceChannelId), button("Editar", () => openScene(scene)), button("Excluir", async () => { if (!confirm(`Excluir a cena “${scene.name}”? Os áudios serão mantidos.`)) return; await api(`/api/scenes/${scene.id}`, { method: "DELETE" }); await refresh(); }))));
    if (!data.scenes.length) $("scene-list").textContent = "Nenhuma cena salva. Monte a primeira com música, ambientes e efeitos.";
    if (!data.scenes.some(scene => scene.id === sceneSelection)) sceneSelection = "";
    updateSelect($("soundboard-scene"), [["", "Favoritos da biblioteca"], ...data.scenes.map(scene => [scene.id, scene.name])], sceneSelection);
    const ids = data.scenes.find(scene => scene.id === sceneSelection)?.effectIds;
    const effects = appState.library.filter(track => track.category === "effect" && (ids ? ids.includes(track.id) : track.favorite));
    $("scene-effects").replaceChildren(...effects.map(track => button(`${track.title}${shortcuts[track.id] ? ` [${shortcuts[track.id]}]` : ""}`, () => playEffect(track.id), !session?.voiceChannelId)));
    if (!effects.length) $("scene-effects").textContent = "Escolha efeitos na cena ou marque favoritos na biblioteca.";
    for (const [container, layers] of [["environment-list", session?.environments || []], ["live-effects", session?.activeEffects || []]]) {
      renderLayers(container, layers);
    }
    $("trash-list").replaceChildren(...data.trash.map(entry => row(label(`${entry.track.title} · ${entry.track.relativePath}`), button("Restaurar", async () => { await json("/api/studio/library", { action: "restore", trackId: entry.track.id }); await refresh(); }))));
    if (!data.trash.length) $("trash-list").textContent = "Lixeira vazia.";
    $("trash-purge").hidden = appState.access.principal?.role !== "owner"; $("trash-purge").disabled = !data.trash.length;
    $("duplicate-list").replaceChildren(...data.duplicates.map(group => { const section = document.createElement("div"); section.className = "duplicate-group"; section.append(...group.map(track => row(label(track.relativePath), button("Editar / mover à lixeira", () => openTrackEditor(track))))); return section; }));
    if (!data.duplicates.length) $("duplicate-list").textContent = "Nenhum duplicado encontrado na última indexação.";
    window.sonoraSharing?.permissions();
  }
  document.addEventListener("click", event => {
    if (!event.target.closest?.(".track-menu")) for (const menu of document.querySelectorAll(".track-menu[open]")) menu.open = false;
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      for (const menu of document.querySelectorAll(".track-menu[open]")) { menu.open = false; menu.querySelector("summary")?.focus(); }
      document.body.classList.remove("presentation-mode"); $("presentation-toggle").textContent = "Modo apresentação";
    }
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.target.closest("input, textarea, select, [contenteditable=true]") || document.querySelector("dialog[open]")) return;
    if (!["studio", "effects"].includes(appState.view)) return;
    const id = Object.keys(shortcuts).find(id => shortcuts[id] === event.key.toUpperCase());
    if (id && trackById(id)?.category === "effect" && activeSession()?.voiceChannelId) { event.preventDefault(); void playEffect(id); }
  });
  addFilters("music"); addFilters("effect");
  elements["delete-track-button"].textContent = "Mover para lixeira";
  window.sonoraStudio = { render, refresh, control, filter, trackActions, upload, childFolders, reset: () => { generation++; Object.assign(data, { scenes: [], folders: [], trash: [], duplicates: [] }); loaded = false; sceneSelection = ""; layerRows.clear(); preview.pause(); preview.removeAttribute("src"); preview.load(); previewTitle.textContent = ""; previewPanel.hidden = true; document.body.classList.remove("presentation-mode"); $("presentation-toggle").textContent = "Modo apresentação"; }, effectSearch: () => filters.effect.search, hasFolder: (category, folder) => data.folders.includes(`${category === "music" ? "music" : "effects"}/${folder}`) };
  renderLibrary(); renderNavigation(); render();
})();
