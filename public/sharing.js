(() => {
  const $ = id => document.getElementById(id);
  const profiles = { full: "Controle completo de áudio", playback: "Somente reprodução", effects: "Somente efeitos" };
  const profileHelp = { full: "Controla músicas, efeitos e ambientes. A gestão de acessos e os backups continuam exclusivos do anfitrião.", playback: "Controla a fila, o volume da música e a reprodução. Não dispara efeitos nem modifica a biblioteca.", effects: "Dispara e interrompe efeitos sem alterar a música. Não modifica a fila nem a biblioteca." };
  let actions = []; let loaded = false; let loading = false;
  const button = (text, action) => { const el = document.createElement("button"); el.type = "button"; el.className = "secondary-button"; el.textContent = text; el.addEventListener("click", () => Promise.resolve().then(action).catch(error => showToast(error.message, true))); return el; };
  function policyFields(prefix) {
    const fields = document.createElement("div"); fields.className = "access-policy-fields";
    fields.innerHTML = `<label>O que esta pessoa pode controlar<select id="${prefix}-profile" aria-describedby="${prefix}-help">${Object.entries(profiles).map(([value, name]) => `<option value="${value}">${name}</option>`).join("")}</select></label><p id="${prefix}-help" class="policy-help"></p>
      <label class="policy-toggle"><input id="${prefix}-restricted" type="checkbox" aria-controls="${prefix}-servers"> Limitar a servidores específicos</label>
      <div id="${prefix}-servers" class="policy-servers"><p>Selecione os servidores permitidos ou informe os IDs abaixo.</p><div id="${prefix}-suggestions" class="policy-suggestions" aria-label="Servidores disponíveis"></div>
      <label>IDs dos servidores autorizados<input id="${prefix}-guilds" placeholder="Ex.: 123456789, 987654321" inputmode="numeric" autocomplete="off"></label><small>A biblioteca e as cenas são compartilhadas. Convidados limitados a servidores não podem editar arquivos, playlists ou cenas globais.</small></div>`;
    fields.querySelector(`#${prefix}-profile`).addEventListener("change", () => syncPolicy(prefix));
    fields.querySelector(`#${prefix}-restricted`).addEventListener("change", () => syncPolicy(prefix));
    fields.querySelector(`#${prefix}-guilds`).addEventListener("input", () => markSuggestions(prefix));
    return fields;
  }
  function markSuggestions(prefix) {
    const ids = new Set($(`${prefix}-guilds`).value.split(/[\s,]+/).filter(Boolean));
    $(`${prefix}-suggestions`).querySelectorAll("button").forEach(el => el.setAttribute("aria-pressed", String(ids.has(el.dataset.guildId))));
  }
  function syncPolicy(prefix) {
    const restricted = $(`${prefix}-restricted`).checked;
    $(`${prefix}-servers`).hidden = !restricted;
    $(`${prefix}-guilds`).disabled = !restricted;
    $(`${prefix}-restricted`).setAttribute("aria-expanded", String(restricted));
    $(`${prefix}-help`).textContent = profileHelp[$(`${prefix}-profile`).value];
    markSuggestions(prefix);
  }
  function readPolicy(prefix) {
    const restricted = $(`${prefix}-restricted`).checked;
    const guildIds = restricted ? [...new Set($(`${prefix}-guilds`).value.split(/[\s,]+/).filter(Boolean))] : null;
    if (restricted && !guildIds.length) throw new Error("Informe ao menos um servidor, ou desmarque a restrição.");
    if (guildIds?.some(id => !/^\d{1,30}$/.test(id))) throw new Error("Informe IDs numéricos dos servidores.");
    if (guildIds?.length > 100) throw new Error("Selecione no máximo 100 servidores.");
    return { profile: $(`${prefix}-profile`).value, guildIds };
  }
  elements["create-invite"].before(policyFields("invite-policy"));
  const dialog = document.createElement("dialog"); dialog.className = "sharing-policy-dialog"; dialog.setAttribute("aria-labelledby", "policy-title");
  const policyForm = document.createElement("form"); policyForm.innerHTML = '<p class="eyebrow">CONTROLE COMPARTILHADO</p><h2 id="policy-title">Permissões do convidado</h2><p id="policy-name"></p>'; policyForm.append(policyFields("edit-policy"));
  let editing = null; let savingPolicy = false;
  const policyError = document.createElement("p"); policyError.className = "access-error"; policyError.setAttribute("role", "alert"); policyError.hidden = true;
  const policyActions = document.createElement("div"); policyActions.className = "dialog-actions";
  const savePolicy = document.createElement("button"); savePolicy.type = "submit"; savePolicy.className = "primary-button"; savePolicy.textContent = "Salvar permissões";
  const cancelPolicy = button("Cancelar", () => dialog.close()); policyActions.append(cancelPolicy, savePolicy); policyForm.append(policyError, policyActions); dialog.append(policyForm); document.body.append(dialog);
  policyForm.addEventListener("submit", async event => {
    event.preventDefault(); if (savingPolicy || !editing) return;
    const generation = sessionGeneration; savingPolicy = true; savePolicy.disabled = true; savePolicy.textContent = "Salvando…"; policyError.hidden = true;
    try {
      const result = await api(`/api/access/collaborators/${editing}`, { method: "PATCH", body: JSON.stringify(readPolicy("edit-policy")) });
      if (generation !== sessionGeneration) return;
      appState.accessManagement = result; dialog.close(); renderAccessManagement(); showToast("Permissões atualizadas. As conexões abertas desse convidado foram encerradas.");
    } catch (error) { if (generation === sessionGeneration) { policyError.textContent = error.message; policyError.hidden = false; } }
    finally { if (generation === sessionGeneration) { savingPolicy = false; savePolicy.disabled = false; savePolicy.textContent = "Salvar permissões"; } }
  });
  function suggestions(prefix) {
    const target = $(`${prefix}-suggestions`);
    const signature = JSON.stringify(appState.sessions.map(({ guildId, guildName }) => [guildId, guildName]));
    if (target.dataset.signature !== signature) {
      target.dataset.signature = signature;
      target.replaceChildren(...appState.sessions.map(session => {
        const el = button(session.guildName, () => {
          const field = $(`${prefix}-guilds`); const ids = new Set(field.value.split(/[\s,]+/).filter(Boolean));
          if (ids.has(session.guildId)) ids.delete(session.guildId); else ids.add(session.guildId);
          field.value = [...ids].join(", "); markSuggestions(prefix);
        }); el.dataset.guildId = session.guildId; return el;
      }));
    }
    syncPolicy(prefix);
  }
  function editAccess(item, collaborator) {
    const info = document.createElement("small"); info.textContent = `${profiles[collaborator.profile || "full"]} · ${collaborator.guildIds == null ? "Todos os servidores" : `${collaborator.guildIds.length} servidor(es)`}`;
    info.className = "access-policy-summary";
    const controls = document.createElement("div"); controls.className = "access-item-actions";
    const revoke = item.querySelector("button");
    controls.append(button("Permissões", () => {
      editing = collaborator.id; $("policy-name").textContent = collaborator.displayName;
      $("edit-policy-profile").value = collaborator.profile || "full"; $("edit-policy-restricted").checked = collaborator.guildIds != null; $("edit-policy-guilds").value = collaborator.guildIds?.join(", ") || "";
      policyError.hidden = true; suggestions("edit-policy"); dialog.showModal();
    })); if (revoke) controls.append(revoke); item.append(info, controls);
  }
  const accountActions = document.createElement("div"); accountActions.className = "sharing-account-actions";
  const logoutButton = button("Sair da sessão", () => logout()); logoutButton.id = "mobile-logout";
  const permissionLabel = document.createElement("p"); permissionLabel.id = "permission-label"; accountActions.append(permissionLabel, logoutButton); document.querySelector(".topbar").append(accountActions);
  const history = document.createElement("details"); history.className = "panel sharing-history";
  history.innerHTML = '<summary>Ações recentes <span id="recent-action-count">0</span></summary><p>Últimas 100 ações desta execução, apenas dos servidores aos quais você tem acesso.</p><ol id="recent-actions"></ol>';
  $("player-view").append(history);
  function activity(item) {
    if (!appState.access.authenticated) return;
    actions = [item, ...actions.filter(action => action.id !== item.id)].slice(0, 100); renderActivity();
  }
  function renderActivity() {
    $("recent-action-count").textContent = String(actions.length);
    $("recent-actions").replaceChildren(...actions.map(item => {
      const li = document.createElement("li"); const time = document.createElement("time"); time.dateTime = item.at; time.textContent = new Date(item.at).toLocaleTimeString("pt-BR");
      const content = document.createElement("div"); const action = document.createElement("strong"); action.textContent = item.action;
      const actor = document.createElement("span"); actor.textContent = `${item.actor}${item.guildId ? ` · ${appState.sessions.find(session => session.guildId === item.guildId)?.guildName || item.guildId}` : ""}`;
      content.append(action, actor); li.append(time, content); return li;
    }));
    if (!actions.length) { const empty = document.createElement("li"); empty.className = "sharing-history-empty"; empty.textContent = "As próximas ações aparecerão aqui."; $("recent-actions").append(empty); }
  }
  const maintenance = document.createElement("section"); maintenance.id = "backup-panel"; maintenance.className = "panel studio-section";
  maintenance.innerHTML = `<h3>Backup e restauração</h3><p>Guarde sua biblioteca, playlists, cenas e filas. Tokens, convites e sessões de acesso nunca entram no backup.</p>
    <div class="backup-columns"><section class="backup-card"><h4>Guardar uma cópia</h4><p>Salve a organização da sua mesa. Inclua os áudios para levar tudo a outro computador.</p>
    <label class="policy-toggle"><input id="backup-audio" type="checkbox"> Incluir arquivos de áudio</label><small>Com áudios, o download pode ser grande.</small><button id="backup-export" type="button" class="secondary-button">Baixar backup</button></section>
    <section class="backup-card"><h4>Restaurar uma cópia</h4><label for="backup-file">Arquivo .sonora.gz</label><input id="backup-file" type="file" accept=".gz,.sonora.gz" aria-describedby="backup-file-detail backup-warning"><small id="backup-file-detail">Nenhum arquivo selecionado.</small><button id="backup-restore" type="button" class="danger-button" disabled>Restaurar backup</button></section></div>
    <p id="backup-warning" class="backup-warning">Restaurar interrompe o áudio, desconecta as calls e substitui os metadados. Uma cópia anterior é guardada localmente. Se o backup não incluir áudios, os arquivos já devem existir neste computador.</p><small>O limite MAX_UPLOAD_MB também se aplica ao conteúdo descompactado.</small><p id="backup-status" role="status" aria-live="polite" hidden></p>`;
  document.querySelector('[data-view-panel="settings"]').append(maintenance);
  let backupBusy = false;
  let backupController = null;
  function syncBackupControls() {
    $("backup-export").disabled = backupBusy; $("backup-restore").disabled = backupBusy || !$("backup-file").files.length;
    $("backup-file").disabled = backupBusy; $("backup-audio").disabled = backupBusy;
    maintenance.setAttribute("aria-busy", String(backupBusy));
  }
  function backupStatus(message, error = false) {
    $("backup-status").textContent = message; $("backup-status").hidden = !message; $("backup-status").classList.toggle("is-error", error);
  }
  $("backup-file").addEventListener("change", () => {
    const file = $("backup-file").files[0];
    $("backup-file-detail").textContent = file ? `${file.name} · ${(file.size / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} MB` : "Nenhum arquivo selecionado.";
    backupStatus(""); syncBackupControls();
  });
  async function backupRequest(url, options) {
    const headers = new Headers(options.headers); if (appState.access.csrfToken) headers.set("X-CSRF-Token", appState.access.csrfToken);
    const generation = sessionGeneration;
    const response = await fetch(url, { ...options, headers, credentials: "same-origin", signal: backupController?.signal });
    if (generation !== sessionGeneration) throw new Error("Sessão encerrada.");
    if (response.status === 401) { endSession(); throw new Error("Entre novamente."); }
    if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || "Falha no backup."); } return response;
  }
  async function runBackup(action) {
    if (backupBusy) return;
    const generation = sessionGeneration; backupBusy = true; backupController = new AbortController(); syncBackupControls();
    try { await action(generation); } catch (error) { if (generation === sessionGeneration) backupStatus(error.message, true); }
    finally { if (generation === sessionGeneration) { backupBusy = false; backupController = null; syncBackupControls(); } }
  }
  $("backup-export").addEventListener("click", () => runBackup(async generation => {
    backupStatus("Preparando backup…");
    await api("/api/auth/session");
    if (generation !== sessionGeneration) return;
    const a = document.createElement("a"); a.href = `/api/backups/export?includeAudio=${$("backup-audio").checked}`; a.download = `sonora-${new Date().toISOString().slice(0, 10)}.sonora.gz`; document.body.append(a); a.click(); a.remove();
    backupStatus("Download solicitado. Aguarde a conclusão na lista de downloads do navegador antes de restaurar ou alterar a biblioteca.");
  }));
  $("backup-restore").addEventListener("click", () => runBackup(async generation => {
    const file = $("backup-file").files[0]; if (!file) throw new Error("Escolha um arquivo de backup.");
    if (!confirm("Restaurar este backup? Isso para o áudio, desconecta as calls e substitui biblioteca, playlists, cenas e filas. Uma cópia de segurança será criada antes das mudanças.")) return;
    backupStatus("Validando e restaurando… Não feche esta página."); const form = new FormData(); form.append("file", file);
    const response = await backupRequest("/api/backups/restore", { method: "POST", headers: { "X-Sonora-Confirm": "restore" }, body: form }); const result = await response.json();
    if (generation !== sessionGeneration) return;
    backupStatus(`${result.message} Cópia anterior: ${result.safetyBackup}.`); $("backup-file").value = ""; $("backup-file-detail").textContent = "Nenhum arquivo selecionado.";
    await loadDashboard(); if (generation === sessionGeneration) await window.sonoraStudio.refresh();
  }));
  function permissions() {
    const principal = appState.access.principal; const owner = principal?.role === "owner"; const full = owner || (principal?.profile || "full") === "full";
    const edit = owner || (full && principal?.guildIds == null); const effects = owner || principal?.profile !== "playback"; const playback = owner || principal?.profile !== "effects";
    document.body.classList.toggle("read-only-library", !edit); document.body.classList.toggle("effects-only", !playback); document.body.classList.toggle("playback-only", !effects); document.body.classList.toggle("limited-audio", !full);
    for (const id of ["upload-music-button", "upload-effect-button", "scan-button", "new-playlist-button", "edit-playlist-button", "scene-new"]) $(id).hidden = !edit;
    for (const id of ["stop-button", "play-pause-button", "skip-button", "loop-button", "clear-queue", "external-form", "queue-playlist-button"]) $(id).hidden = !playback;
    for (const id of ["environment-add", "environment-volume", "environment-track", "ducking"]) $(id).disabled = !full || !activeSession()?.voiceChannelId;
    $("environment-add").disabled ||= !appState.library.length || (activeSession()?.environments?.length || 0) >= 3;
    if (!effects) document.querySelectorAll(".effect-play, .studio-soundboard button, #live-effects button").forEach(button => { button.disabled = true; });
    $("leave-button").hidden = !full; $("effect-volume-input").disabled = !effects || !activeSession(); $("effects-stop-all").hidden = !effects;
    $("volume-input").disabled = !playback || !activeSession();
    maintenance.hidden = !owner;
  }
  function render() {
    permissions(); suggestions("invite-policy"); renderActivity();
    const principal = appState.access.principal;
    logoutButton.hidden = !appState.access.authenticated || !appState.access.csrfToken;
    permissionLabel.textContent = principal?.role === "collaborator" ? `${profiles[principal.profile || "full"]}${principal.guildIds != null ? " · servidores limitados" : ""}` : "";
    permissionLabel.hidden = !permissionLabel.textContent;
    accountActions.hidden = !appState.access.authenticated;
    if (appState.access.authenticated && !loaded && !loading) {
      loading = true; const generation = sessionGeneration;
      api("/api/activity").then(result => { if (generation === sessionGeneration) { const combined = [...actions, ...result.actions]; actions = [...new Map(combined.map(item => [item.id, item])).values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100); loaded = true; renderActivity(); } }).catch(() => {}).finally(() => { if (generation === sessionGeneration) loading = false; });
    }
  }
  function reset() {
    actions = []; loaded = false; loading = false; editing = null; savingPolicy = false;
    savePolicy.disabled = false; savePolicy.textContent = "Salvar permissões"; policyError.hidden = true; policyError.textContent = "";
    if (dialog.open) dialog.close(); policyForm.reset(); $("policy-name").textContent = "";
    for (const prefix of ["invite-policy", "edit-policy"]) {
      $(`${prefix}-profile`).value = "full"; $(`${prefix}-restricted`).checked = false; $(`${prefix}-guilds`).value = "";
      $(`${prefix}-suggestions`).replaceChildren(); delete $(`${prefix}-suggestions`).dataset.signature; syncPolicy(prefix);
    }
    backupController?.abort(); backupController = null; backupBusy = false;
    $("backup-file").value = ""; $("backup-audio").checked = false; $("backup-file-detail").textContent = "Nenhum arquivo selecionado.";
    backupStatus(""); syncBackupControls(); history.open = false; renderActivity();
  }
  window.sonoraSharing = { render, permissions, editAccess, invitationPolicy: () => readPolicy("invite-policy"), activity, reset };
  syncPolicy("edit-policy"); syncBackupControls();
  renderAccessManagement(); render();
})();
