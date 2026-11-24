const appState = {
  bot: { configured: false, connected: false, username: null },
  library: [],
  playlists: [],
  sessions: [],
  selectedGuildId: sessionStorage.getItem("sonora:guild") || "",
  selectedPlaylistId: sessionStorage.getItem("sonora:playlist") || "",
  filterPlaylistId: sessionStorage.getItem("sonora:playlist-filter") || "",
  musicFolder: sessionStorage.getItem("sonora:music-folder") || "",
  effectFolder: sessionStorage.getItem("sonora:effect-folder") || "",
  view: location.hash.slice(1) || "player",
  uploadCategory: "music",
  access: {
    authenticated: false,
    principal: null,
    csrfToken: null,
    remoteAccessEnabled: false,
    publicUrl: null,
  },
  accessManagement: { collaborators: [], invitations: [] },
  invitationToken: "",
};

const elements = Object.fromEntries(
  [
    "bot-status", "bot-status-title", "bot-status-detail", "guild-select", "playback-label",
    "playback-availability", "playback-availability-title", "playback-availability-copy",
    "current-title", "current-artist", "channel-pill", "timeline-progress", "elapsed-time",
    "duration-time", "player-error", "stop-button", "play-pause-button", "skip-button", "loop-button",
    "loop-label", "volume-input", "volume-output", "session-guild", "session-channel",
    "session-state", "session-queue-count", "session-requester", "leave-button", "clear-queue",
    "queue-list", "queue-empty", "scan-button", "upload-music-button", "library-search",
    "library-playlist-filter", "library-count", "music-list", "external-form", "external-url", "external-add",
    "music-folder-breadcrumbs", "music-folder-actions", "music-folder-play-all",
    "music-folder-shuffle", "music-folder-list",
    "upload-effect-button", "effect-volume-input", "effect-volume-output", "active-effect-count",
    "effects-playlist-filter", "effect-count", "effect-grid", "effects-empty", "effects-empty-title",
    "effects-empty-copy", "effect-folder-breadcrumbs", "effect-folder-actions",
    "effect-folder-play-all", "effect-folder-shuffle", "effect-folder-list",
    "playlist-count", "playlist-list", "playlist-editor",
    "playlists-empty", "playlist-content", "playlist-title", "playlist-description", "playlist-items",
    "playlist-items-empty", "new-playlist-button", "edit-playlist-button", "queue-playlist-button",
    "file-input", "token-dialog", "token-form", "token-input", "open-token", "track-dialog",
    "track-form", "track-dialog-title", "track-id", "track-title-input", "track-artist-input",
    "track-album-input", "track-category-input", "track-file-hint", "delete-track-button",
    "playlist-dialog", "playlist-form", "playlist-dialog-title", "playlist-id", "playlist-name-input",
    "playlist-description-input", "delete-playlist-button", "playlist-picker-dialog",
    "playlist-picker-form", "playlist-picker-title", "playlist-track-id", "playlist-picker-select",
    "toast-region", "app-shell", "invite-gate", "invite-title", "invite-copy", "invite-error",
    "accept-invite", "sharing-nav", "remote-status-dot", "remote-status-title",
    "remote-status-detail", "remote-public-url", "invite-form", "invite-name", "create-invite",
    "generated-invite", "generated-invite-url", "copy-invite", "collaborator-list",
    "collaborator-empty", "invitation-list", "invitation-empty",
  ].map((id) => [id, document.getElementById(id)]),
);

let events;
let draggedEntry = null;
const pendingVolumes = new Map();
let lastShownPlaybackError = "";
let sessionGeneration = 0;

const activeSession = () =>
  appState.sessions.find(({ guildId }) => guildId === appState.selectedGuildId) || null;
const selectedPlaylist = () =>
  appState.playlists.find(({ id }) => id === appState.selectedPlaylistId) || null;
const trackById = (trackId) => appState.library.find(({ id }) => id === trackId) || null;

async function api(path, options = {}, promptForLogin = true) {
  const generation = sessionGeneration;
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const method = String(options.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && appState.access.csrfToken) {
    headers.set("X-CSRF-Token", appState.access.csrfToken);
  }
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (generation !== sessionGeneration && path !== "/api/auth/logout") throw new Error("A sessão mudou. Repita a operação após entrar novamente.");
  if (response.status === 401 && path !== "/api/auth/owner") {
    endSession(false);
    if (promptForLogin && elements["invite-gate"].hidden && !elements["token-dialog"].open) {
      elements["token-dialog"].showModal();
    }
    throw new Error(data.error || "Entre como anfitrião para abrir o painel.");
  }
  if (!response.ok) throw new Error(data.error || "A operação não pôde ser concluída.");
  return data;
}

function connectEvents() {
  events?.close();
  const source = new EventSource("/api/events");
  events = source;
  const current = () => events === source && appState.access.authenticated;
  source.addEventListener("session-ended", () => { if (current()) endSession(); });
  source.addEventListener("activity", ({ data }) => { if (current()) window.sonoraSharing?.activity(JSON.parse(data)); });
  source.addEventListener("state", ({ data }) => { if (current()) applyFullState(JSON.parse(data)); });
  source.addEventListener("studio", () => { if (current()) window.sonoraStudio?.refresh(); });
  source.addEventListener("bot", ({ data }) => {
    if (!current()) return;
    appState.bot = JSON.parse(data);
    renderBot();
    renderPlaybackAvailability();
  });
  source.addEventListener("library", ({ data }) => {
    if (!current()) return;
    appState.library = JSON.parse(data);
    renderLibrary();
    renderPlaylists();
    window.sonoraStudio?.refresh();
  });
  source.addEventListener("playlists", ({ data }) => {
    if (!current()) return;
    applyPlaylists(JSON.parse(data));
  });
  source.addEventListener("session", ({ data }) => {
    if (current()) applySessionUpdate(JSON.parse(data));
  });
  source.onerror = () => {
    if (!current()) return;
    void api("/api/auth/session", {}, false).catch(() => {});
    if (source.readyState === EventSource.CLOSED) {
      showToast("Atualizações em tempo real desconectadas.", true);
    }
  };
}

function applySessionUpdate(session) {
  const index = appState.sessions.findIndex(({ guildId }) => guildId === session.guildId);
  const previous = appState.sessions[index];
  if (previous) appState.sessions[index] = session;
  else appState.sessions.push(session);
  appState.selectedGuildId ||= session.guildId;
  if (!previous || previous.guildName !== session.guildName) renderGuilds();
  if (session.guildId !== appState.selectedGuildId) return;
  if (session.error && session.error !== lastShownPlaybackError) showToast(friendlyPlaybackError(session.error), true);
  lastShownPlaybackError = session.error || "";
  renderPlaybackAvailability();
  renderPlayer();
  updateSourceControls();
  window.sonoraStudio?.render();
  window.sonoraSharing?.render();
}

function applyFullState(next) {
  appState.bot = next.bot;
  appState.library = next.library || [];
  appState.playlists = next.playlists || [];
  appState.sessions = next.sessions || [];
  if (!appState.sessions.some(({ guildId }) => guildId === appState.selectedGuildId)) {
    appState.selectedGuildId = (appState.sessions.find(session => session.voiceChannelId) ?? appState.sessions[0])?.guildId || "";
  }
  ensureSelectedPlaylist();
  ensurePlaylistFilter();
  render();
}

function ensureSelectedPlaylist() {
  if (!appState.playlists.some(({ id }) => id === appState.selectedPlaylistId)) {
    appState.selectedPlaylistId = appState.playlists[0]?.id || "";
  }
  if (appState.selectedPlaylistId) {
    sessionStorage.setItem("sonora:playlist", appState.selectedPlaylistId);
  } else {
    sessionStorage.removeItem("sonora:playlist");
  }
}

function ensurePlaylistFilter() {
  if (!appState.playlists.some(({ id }) => id === appState.filterPlaylistId)) {
    appState.filterPlaylistId = "";
    sessionStorage.removeItem("sonora:playlist-filter");
  }
}

function applyPlaylists(playlists) {
  appState.playlists = playlists;
  ensureSelectedPlaylist();
  ensurePlaylistFilter();
  renderLibrary();
  renderPlaylists();
}

function render() {
  renderBot();
  renderGuilds();
  renderPlaybackAvailability();
  renderPlayer();
  renderLibrary();
  renderPlaylists();
  renderAccess();
  renderNavigation();
  window.sonoraStudio?.render();
  window.sonoraSharing?.render();
}

function renderBot() {
  const status = elements["bot-status"];
  status.classList.toggle("connected", appState.bot.connected);
  status.classList.toggle("error", appState.bot.configured && !appState.bot.connected);
  if (appState.bot.connected) {
    elements["bot-status-title"].textContent = appState.bot.username || "Bot conectado";
    elements["bot-status-detail"].textContent = "Disponível no Discord";
  } else if (!appState.bot.configured) {
    elements["bot-status-title"].textContent = "Configuração pendente";
    elements["bot-status-detail"].textContent = "Preencha o arquivo .env";
  } else {
    elements["bot-status-title"].textContent = "Bot desconectado";
    elements["bot-status-detail"].textContent = "Verifique a credencial";
  }
  if (!appState.bot.connected && appState.bot.state) {
    elements["bot-status-title"].textContent = ({ connecting: "Conectando…", retrying: "Tentando novamente", invalid_config: "Configuração inválida", disconnected: "Bot desconectado" })[appState.bot.state] || "Bot desconectado";
    elements["bot-status-detail"].textContent = appState.bot.lastError || "Aguarde a conexão com o Discord.";
    if (appState.bot.nextRetryAt) elements["bot-status-detail"].textContent += ` Nova tentativa às ${new Date(appState.bot.nextRetryAt).toLocaleTimeString("pt-BR")}.`;
  }
}

function renderGuilds() {
  const select = elements["guild-select"];
  select.replaceChildren();
  if (!appState.sessions.length) {
    select.add(new Option("Nenhuma sessão", ""));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const session of appState.sessions) {
    select.add(new Option(session.guildName, session.guildId));
  }
  select.value = appState.selectedGuildId;
}

function renderPlaybackAvailability() {
  const session = activeSession();
  const notice = elements["playback-availability"];
  notice.hidden = Boolean(appState.bot.connected && session?.voiceChannelId);
  if (notice.hidden) return;
  const title = elements["playback-availability-title"];
  const copy = elements["playback-availability-copy"];
  if (!appState.bot.connected) {
    title.textContent = "O bot ainda não está disponível no Discord";
    const detail = appState.bot.lastError || (!appState.bot.configured
      ? "Configure a conexão do bot no arquivo .env e reinicie o Sonora."
      : "Aguarde a conexão ou confira o estado do bot e os diagnósticos em Preferências.");
    copy.textContent = `${detail} A biblioteca pode ser organizada enquanto isso; para tocar, o bot precisa estar conectado a um canal de voz.`;
  } else {
    title.textContent = session ? `O bot está fora da call em ${session.guildName}` : "Chame o bot para uma call";
    copy.textContent = "Entre em um canal de voz desse servidor e use /join ou /play no Discord. Depois, abra uma pasta e use + Fila, Tocar todas ou um efeito. Se ele já estiver em outra call, confira o servidor selecionado acima.";
  }
}

function renderPlayer() {
  const session = activeSession();
  const current = session?.current;
  const connected = Boolean(session?.voiceChannelId);

  elements["playback-label"].textContent = current
    ? session.status === "paused" ? "REPRODUÇÃO PAUSADA" : session.status === "buffering" ? "CARREGANDO ÁUDIO…" : "TOCANDO AGORA"
    : connected ? "AGUARDANDO ÁUDIO" : "NADA TOCANDO";
  elements["current-title"].textContent = current?.title || "Pronto para a primeira faixa";
  elements["current-artist"].textContent = current ? (current.artist || "Artista desconhecido") : (connected
    ? "Escolha algo na biblioteca."
    : "Use /play no Discord para chamar o bot.");
  elements["channel-pill"].textContent = connected ? `# ${session.voiceChannelName}` : "Fora da call";
  elements["session-guild"].textContent = session?.guildName || "Nenhum servidor";
  elements["session-channel"].textContent = connected ? `# ${session.voiceChannelName}` : "Use /join ou /play";
  elements["session-state"].textContent = statusLabel(session?.status || "idle");
  elements["session-queue-count"].textContent = String(session?.upcoming.length || 0);
  elements["session-requester"].textContent = current?.requestedBy || "—";
  elements["player-error"].hidden = !session?.error;
  elements["player-error"].textContent = session?.error ? friendlyPlaybackError(session.error) : "";
  elements["play-pause-button"].textContent = session?.status === "paused" ? "▶" : "Ⅱ";
  elements["play-pause-button"].setAttribute("aria-label", session?.status === "paused" ? "Retomar" : "Pausar");
  elements["loop-label"].textContent = loopLabel(session?.repeatMode || "off");
  elements["loop-button"].classList.toggle("active", session?.repeatMode !== "off");
  renderVolume("volume", "volume", session, 70);
  renderVolume("effectVolume", "effect-volume", session, 100);
  const activeEffectCount = session?.activeEffects?.length || 0;
  elements["active-effect-count"].textContent = activeEffectCount
    ? `${activeEffectCount} ${activeEffectCount === 1 ? "efeito tocando" : "efeitos tocando"}`
    : "Nenhum efeito tocando";
  elements["stop-button"].disabled = !(current || session?.upcoming.length || activeEffectCount || session?.environments?.length);
  elements["play-pause-button"].disabled = !current || !connected;
  elements["skip-button"].disabled = !current || !connected;
  elements["loop-button"].disabled = !session;
  elements["clear-queue"].disabled = !session?.upcoming.length;
  elements["leave-button"].disabled = !connected;
  renderQueue(session?.upcoming || [], session);
  renderProgress();
}

function renderVolume(action, prefix, session, fallback) {
  const value = pendingVolumes.get(`${session?.guildId}/${action}`)?.value ?? session?.[action] ?? fallback;
  elements[`${prefix}-input`].value = String(value);
  elements[`${prefix}-input`].disabled = !session;
  elements[`${prefix}-output`].textContent = `${value}%`;
}

function renderProgress() {
  const session = activeSession();
  const current = session?.current;
  const duration = current?.durationMs || 0;
  let elapsed = 0;
  if (session?.startedAt) {
    const endpoint = ["paused", "buffering"].includes(session.status) && session.pausedAt
      ? new Date(session.pausedAt).getTime()
      : Date.now();
    elapsed = Math.max(0, endpoint - new Date(session.startedAt).getTime());
  }
  if (duration) elapsed = Math.min(elapsed, duration);
  elements["timeline-progress"].style.width = duration ? `${(elapsed / duration) * 100}%` : "0%";
  elements["elapsed-time"].textContent = formatDuration(elapsed);
  elements["duration-time"].textContent = duration ? formatDuration(duration) : "--:--";
}

function renderQueue(queue, session) {
  const list = elements["queue-list"];
  const signature = JSON.stringify([session?.guildId, Boolean(session?.voiceChannelId), queue]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const focusedRow = focused?.closest(".queue-item");
  list.replaceChildren();
  elements["queue-empty"].hidden = queue.length > 0;
  for (const [index, track] of queue.entries()) {
    const item = document.createElement("li");
    item.className = "queue-item";
    item.draggable = true;
    item.dataset.entryId = track.entryId;
    item.innerHTML = `
      <span class="queue-index">${String(index + 1).padStart(2, "0")}</span>
      <button class="queue-title" data-action="play" type="button" aria-label="Tocar ${escapeHtml(track.title)} agora"><strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist || track.requestedBy)}</small></button>
      <span class="queue-duration">${formatDuration(track.durationMs)}</span>
      <button class="icon-button" data-action="remove" type="button" aria-label="Remover ${escapeHtml(track.title)}">×</button>`;
    const play = item.querySelector('[data-action="play"]');
    play.disabled = !session?.voiceChannelId;
    play.addEventListener("click", () => window.sonoraStudio?.control({ action: "entry", entryId: track.entryId, operation: "play" }));
    item.querySelector('[data-action="remove"]').addEventListener("click", () => window.sonoraStudio?.control({ action: "entry", entryId: track.entryId, operation: "remove" }));
    item.addEventListener("dragstart", (event) => {
      draggedEntry = { entryId: track.entryId, guildId: session?.guildId };
      event.dataTransfer?.setData("text/plain", track.title);
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => { draggedEntry = null; item.classList.remove("dragging"); });
    item.addEventListener("dragover", (event) => event.preventDefault());
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      if (draggedEntry?.guildId === session?.guildId && draggedEntry?.entryId && draggedEntry.entryId !== track.entryId) window.sonoraStudio?.control({ action: "entry", entryId: draggedEntry.entryId, operation: "before", beforeId: track.entryId });
      draggedEntry = null;
    });
    list.append(item);
  }
  if (focusedRow) {
    const sameRow = Array.from(list.children).find(item => item.dataset.entryId === focusedRow.dataset.entryId);
    (sameRow?.querySelector(`[data-action="${focused.dataset.action}"]`) || list.querySelector("button:not(:disabled)"))?.focus({ preventScroll: true });
  }
}

const ROOT_FILES_FOLDER = ".";

function renderLibrary() {
  renderPlaylistFilterControls();
  const filteredTrackIds = playlistFilterTrackIds();
  renderMusicFolders(filteredTrackIds);
  renderEffectFolders(filteredTrackIds);
  updateSourceControls();
  window.sonoraSharing?.permissions();
}

function updateSourceControls() {
  const session = activeSession();
  const connected = Boolean(session?.voiceChannelId);
  for (const button of document.querySelectorAll('.track-row [data-action="queue"], .effect-play')) button.disabled = !connected;
  const activeIds = new Set(session?.activeEffects?.map(effect => effect.trackId));
  for (const card of document.querySelectorAll(".effect-card")) card.classList.toggle("active", activeIds.has(card.dataset.trackId));
  for (const prefix of ["music", "effect"]) {
    for (const suffix of ["play-all", "shuffle"]) {
      const control = elements[`${prefix}-folder-${suffix}`];
      control.disabled = !connected || !control.dataset.trackIds;
    }
  }
  elements["queue-playlist-button"].disabled = !connected || !selectedPlaylist()?.items.some(item => trackById(item.trackId));
  elements["external-add"].disabled = !connected || elements["external-form"].dataset.pending === "true";
}

function trackFolder(track) {
  const parts = String(track.relativePath).split(/[\\/]+/).filter(Boolean);
  return parts.slice(1, -1).join("/");
}

function tracksForCategory(category, filteredTrackIds) {
  const tracks = appState.library.filter((track) =>
    track.category === category && (!filteredTrackIds || filteredTrackIds.has(track.id)));
  return window.sonoraStudio?.filter(tracks, category) ?? tracks;
}

function folderContains(folder, track, recursive = false) {
  const candidate = trackFolder(track);
  if (folder === ROOT_FILES_FOLDER) return candidate === "";
  return recursive
    ? candidate === folder || candidate.startsWith(`${folder}/`)
    : candidate === folder;
}

function childFolders(tracks, currentFolder) {
  if (currentFolder === ROOT_FILES_FOLDER) return [];
  const prefix = currentFolder ? `${currentFolder}/` : "";
  const folders = new Set();
  for (const track of tracks) {
    const folder = trackFolder(track);
    if (!folder || (currentFolder && !folder.startsWith(prefix))) continue;
    const remaining = folder.slice(prefix.length);
    const child = remaining.split("/")[0];
    if (child) folders.add(`${prefix}${child}`);
  }
  return [...folders].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

function setFolder(category, folder) {
  const stateKey = category === "music" ? "musicFolder" : "effectFolder";
  const storageKey = category === "music" ? "sonora:music-folder" : "sonora:effect-folder";
  appState[stateKey] = folder;
  if (folder) sessionStorage.setItem(storageKey, folder);
  else sessionStorage.removeItem(storageKey);
  renderLibrary();
}

function ensureFolderSelection(category) {
  const stateKey = category === "music" ? "musicFolder" : "effectFolder";
  const selected = appState[stateKey];
  if (!selected) return "";
  const categoryTracks = appState.library.filter((track) => track.category === category);
  const exists = selected === ROOT_FILES_FOLDER
    ? categoryTracks.some((track) => trackFolder(track) === "")
    : categoryTracks.some((track) => folderContains(selected, track, true)) || window.sonoraStudio?.hasFolder(category, selected);
  if (!exists) {
    const storageKey = category === "music" ? "sonora:music-folder" : "sonora:effect-folder";
    appState[stateKey] = "";
    sessionStorage.removeItem(storageKey);
  }
  return exists ? selected : "";
}

function renderFolderNavigation(category, tracks, currentFolder, options = {}) {
  const prefix = category === "music" ? "music" : "effect";
  const rootLabel = category === "music" ? "Músicas" : "Efeitos";
  const breadcrumbs = elements[`${prefix}-folder-breadcrumbs`];
  const folderList = elements[`${prefix}-folder-list`];
  const actions = elements[`${prefix}-folder-actions`];
  breadcrumbs.replaceChildren();
  folderList.replaceChildren();

  if (options.searching) {
    const root = breadcrumbButton(rootLabel, () => setFolder(category, ""));
    breadcrumbs.append(root, breadcrumbSeparator(), breadcrumbButton("Resultados da busca", null));
    actions.hidden = tracks.length === 0;
    setFolderActionState(prefix, tracks);
    return { visibleTracks: tracks, hasFolders: false };
  }

  const rootButton = breadcrumbButton(rootLabel, currentFolder ? () => setFolder(category, "") : null);
  breadcrumbs.append(rootButton);
  if (currentFolder === ROOT_FILES_FOLDER) {
    breadcrumbs.append(breadcrumbSeparator(), breadcrumbButton("Sem pasta", null));
  } else if (currentFolder) {
    let path = "";
    for (const [index, part] of currentFolder.split("/").entries()) {
      path = path ? `${path}/${part}` : part;
      const target = path;
      const isCurrent = index === currentFolder.split("/").length - 1;
      breadcrumbs.append(
        breadcrumbSeparator(),
        breadcrumbButton(part, isCurrent ? null : () => setFolder(category, target)),
      );
    }
  }

  const extraFolders = options.filtered ? [] : window.sonoraStudio?.childFolders(category, currentFolder) ?? [];
  const folders = [...new Set([...childFolders(tracks, currentFolder), ...extraFolders])].sort((a, b) => a.localeCompare(b, "pt-BR"));
  if (!currentFolder) {
    const looseTracks = tracks.filter((track) => trackFolder(track) === "");
    if (looseTracks.length) {
      folderList.append(folderCard(category, ROOT_FILES_FOLDER, "Sem pasta", looseTracks));
    }
  }
  for (const folder of folders) {
    const folderTracks = tracks.filter((track) => folderContains(folder, track, true));
    folderList.append(folderCard(category, folder, folder.split("/").at(-1), folderTracks));
  }

  const isOverview = currentFolder === "";
  const recursiveTracks = isOverview
    ? []
    : tracks.filter((track) => folderContains(currentFolder, track, true));
  const visibleTracks = isOverview
    ? []
    : tracks.filter((track) => folderContains(currentFolder, track));
  actions.hidden = isOverview || recursiveTracks.length === 0;
  setFolderActionState(prefix, recursiveTracks);
  return { visibleTracks, hasFolders: folderList.childElementCount > 0 };
}

function breadcrumbButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = !action;
  if (action) button.addEventListener("click", action);
  return button;
}

function breadcrumbSeparator() {
  const separator = document.createElement("span");
  separator.textContent = "/";
  separator.setAttribute("aria-hidden", "true");
  return separator;
}

function folderCard(category, folder, label, tracks) {
  const button = document.createElement("button");
  button.className = "folder-card";
  button.type = "button";
  const duration = tracks.reduce((total, track) => total + (track.durationMs || 0), 0);
  button.innerHTML = `
    <span class="folder-icon" aria-hidden="true"><i></i></span>
    <span class="folder-card-copy"><strong>${escapeHtml(label)}</strong><small>${tracks.length} ${tracks.length === 1 ? "áudio" : "áudios"}${duration ? ` · ${formatLongDuration(duration)}` : ""}</small></span>
    <span class="folder-open" aria-hidden="true">›</span>`;
  button.addEventListener("click", () => setFolder(category, folder));
  return button;
}

function setFolderActionState(prefix, tracks) {
  const disabled = !tracks.length || !activeSession()?.voiceChannelId;
  elements[`${prefix}-folder-play-all`].disabled = disabled;
  elements[`${prefix}-folder-shuffle`].disabled = disabled;
  elements[`${prefix}-folder-play-all`].dataset.trackIds = tracks.map(({ id }) => id).join(",");
  elements[`${prefix}-folder-shuffle`].dataset.trackIds = tracks.map(({ id }) => id).join(",");
}

function renderMusicFolders(filteredTrackIds) {
  const allMusic = appState.library.filter((track) => track.category === "music");
  const eligibleMusic = tracksForCategory("music", filteredTrackIds);
  const query = elements["library-search"].value.trim().toLocaleLowerCase("pt-BR");
  const currentFolder = ensureFolderSelection("music");
  const searchedMusic = query
    ? eligibleMusic.filter((track) =>
      [track.title, track.artist, track.album, track.relativePath, ...(track.tags || [])]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("pt-BR")
        .includes(query))
    : eligibleMusic;
  elements["library-count"].textContent = filteredTrackIds || query
    ? `${searchedMusic.length} de ${allMusic.length} ${allMusic.length === 1 ? "faixa" : "faixas"}`
    : `${allMusic.length} ${allMusic.length === 1 ? "faixa" : "faixas"}`;

  const navigation = renderFolderNavigation("music", searchedMusic, currentFolder, {
    searching: Boolean(query),
    filtered: Boolean(filteredTrackIds) || eligibleMusic.length < allMusic.length,
  });
  const list = elements["music-list"];
  list.replaceChildren();
  list.hidden = !navigation.visibleTracks.length && navigation.hasFolders;
  if (!navigation.visibleTracks.length && !navigation.hasFolders) {
    const title = query ? "Nenhuma faixa encontrada." : currentFolder ? "Esta pasta está vazia." : "Nenhuma pasta encontrada.";
    const copy = filteredTrackIds
      ? "A playlist escolhida não possui músicas aqui. Volte uma pasta ou remova o filtro."
      : query ? "Tente outro título, artista, álbum ou pasta." : "Adicione um arquivo ou reindexe a pasta de áudio.";
    list.innerHTML = `<div class="empty-state"><span>♫</span><p>${title}</p><small>${copy}</small></div>`;
  }
  for (const [index, track] of navigation.visibleTracks.entries()) {
    list.append(musicTrackRow(track, index));
  }
}

function musicTrackRow(track, index) {
  const row = document.createElement("div");
  row.className = "track-row";
  row.innerHTML = `
    <span class="track-number">${String(index + 1).padStart(2, "0")}</span>
    <span><strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist || "Artista desconhecido")}</small></span>
    <span class="track-album" title="${escapeHtml(track.relativePath)}">${escapeHtml(track.album || track.relativePath)}</span>
    <span class="queue-duration">${formatDuration(track.durationMs)}</span>
    <span class="track-actions">
      <button class="track-action" data-action="queue" type="button">+ Fila</button>
      <button class="track-action subtle" data-action="playlist" type="button">+ Playlist</button>
      <button class="track-action subtle" data-action="edit" type="button">Editar</button>
    </span>`;
  const queueButton = row.querySelector('[data-action="queue"]');
  queueButton.disabled = !activeSession()?.voiceChannelId;
  queueButton.addEventListener("click", () => enqueue(track.id, "end"));
  row.querySelector('[data-action="playlist"]').addEventListener("click", () => openPlaylistPicker(track));
  row.querySelector('[data-action="edit"]').addEventListener("click", () => openTrackEditor(track));
  window.sonoraStudio?.trackActions(row.querySelector(".track-actions"), track);
  return row;
}

function renderEffectFolders(filteredTrackIds) {
  const allEffects = appState.library.filter((track) => track.category === "effect");
  const eligibleEffects = tracksForCategory("effect", filteredTrackIds);
  const currentFolder = ensureFolderSelection("effect");
  const searching = Boolean(window.sonoraStudio?.effectSearch());
  const navigation = renderFolderNavigation("effect", eligibleEffects, currentFolder, { searching, filtered: Boolean(filteredTrackIds) || eligibleEffects.length < allEffects.length });
  elements["effect-count"].textContent = filteredTrackIds || eligibleEffects.length < allEffects.length
    ? `${eligibleEffects.length} de ${allEffects.length} ${allEffects.length === 1 ? "efeito" : "efeitos"}`
    : `${allEffects.length} ${allEffects.length === 1 ? "efeito" : "efeitos"}`;

  const grid = elements["effect-grid"];
  grid.replaceChildren();
  grid.hidden = navigation.visibleTracks.length === 0;
  elements["effects-empty"].hidden = navigation.visibleTracks.length > 0 || navigation.hasFolders;
  elements["effects-empty-title"].textContent = searching ? "Nenhum efeito encontrado." : currentFolder
    ? "Nenhum efeito nesta pasta."
    : "Nenhuma pasta de efeitos encontrada.";
  elements["effects-empty-copy"].textContent = filteredTrackIds
    ? "Volte uma pasta, escolha outra playlist ou remova o filtro."
    : searching ? "Tente buscar por outro nome, caminho ou etiqueta." : "Adicione arquivos curtos ou organize-os em data/audio/effects.";
  for (const track of navigation.visibleTracks) {
    grid.append(effectTrackCard(track));
  }
}

function effectTrackCard(track) {
  const card = document.createElement("article");
  card.className = "effect-card";
  card.dataset.trackId = track.id;
  card.classList.toggle("active", Boolean(activeSession()?.activeEffects?.some(({ trackId }) => trackId === track.id)));
  card.innerHTML = `
    <button class="effect-play" type="button">
      <span>▶</span><strong>${escapeHtml(track.title)}</strong><small>${formatDuration(track.durationMs)} · sobrepor agora</small>
    </button>
    <div class="effect-actions">
      <button class="track-action subtle" data-action="playlist" type="button">+ Playlist</button>
      <button class="track-action subtle" data-action="edit" type="button">Editar</button>
    </div>`;
  const playButton = card.querySelector(".effect-play");
  playButton.disabled = !activeSession()?.voiceChannelId;
  playButton.addEventListener("click", () => playEffect(track.id));
  card.querySelector('[data-action="playlist"]').addEventListener("click", () => openPlaylistPicker(track));
  card.querySelector('[data-action="edit"]').addEventListener("click", () => openTrackEditor(track));
  window.sonoraStudio?.trackActions(card.querySelector(".effect-actions"), track);
  return card;
}

function renderPlaylistFilterControls() {
  ensurePlaylistFilter();
  for (const id of ["library-playlist-filter", "effects-playlist-filter"]) {
    const select = elements[id];
    select.replaceChildren(new Option("Sem filtro", ""));
    for (const playlist of appState.playlists) {
      select.add(new Option(playlist.name, playlist.id));
    }
    select.disabled = appState.playlists.length === 0;
    select.value = appState.filterPlaylistId;
  }
}

function playlistFilterTrackIds() {
  const playlist = appState.playlists.find(({ id }) => id === appState.filterPlaylistId);
  return playlist ? new Set(playlist.items.map(({ trackId }) => trackId)) : null;
}

function renderPlaylists() {
  ensureSelectedPlaylist();
  const list = elements["playlist-list"];
  list.replaceChildren();
  elements["playlist-count"].textContent = String(appState.playlists.length);
  for (const playlist of appState.playlists) {
    const button = document.createElement("button");
    button.className = "playlist-list-button";
    button.classList.toggle("active", playlist.id === appState.selectedPlaylistId);
    button.type = "button";
    button.innerHTML = `<strong>${escapeHtml(playlist.name)}</strong><small>${playlist.items.length} ${playlist.items.length === 1 ? "item" : "itens"}</small>`;
    button.addEventListener("click", () => {
      appState.selectedPlaylistId = playlist.id;
      sessionStorage.setItem("sonora:playlist", playlist.id);
      renderPlaylists();
    });
    list.append(button);
  }

  const playlist = selectedPlaylist();
  elements["playlists-empty"].hidden = Boolean(playlist);
  elements["playlist-content"].hidden = !playlist;
  if (!playlist) return;

  elements["playlist-title"].textContent = playlist.name;
  elements["playlist-description"].textContent = playlist.description || "Sem descrição.";
  elements["queue-playlist-button"].disabled = !playlist.items.some(item => trackById(item.trackId)) || !activeSession()?.voiceChannelId;
  const items = elements["playlist-items"];
  items.replaceChildren();
  elements["playlist-items-empty"].hidden = playlist.items.length > 0;

  for (const [index, playlistItem] of playlist.items.entries()) {
    const track = trackById(playlistItem.trackId);
    const item = document.createElement("li");
    item.className = "playlist-item";
    item.innerHTML = `
      <span class="playlist-item-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="playlist-item-main"><strong>${escapeHtml(track?.title || "Áudio indisponível")}</strong><small>${escapeHtml(track ? track.artist || track.relativePath : "Arquivo ausente da biblioteca")}</small></span>
      <span class="category-badge">${!track ? "Ausente" : track.category === "effect" ? "Efeito" : "Música"}</span>
      <span class="playlist-item-actions">
        <button class="icon-button" data-action="up" type="button" aria-label="Mover para cima">↑</button>
        <button class="icon-button" data-action="down" type="button" aria-label="Mover para baixo">↓</button>
        <button class="icon-button" data-action="remove" type="button" aria-label="Remover da playlist">×</button>
      </span>`;
    item.querySelector('[data-action="up"]').disabled = index === 0;
    item.querySelector('[data-action="down"]').disabled = index === playlist.items.length - 1;
    item.querySelector('[data-action="up"]').addEventListener("click", () => reorderPlaylistItem(index, index - 1));
    item.querySelector('[data-action="down"]').addEventListener("click", () => reorderPlaylistItem(index, index + 1));
    item.querySelector('[data-action="remove"]').addEventListener("click", () => removePlaylistItem(playlistItem.id));
    items.append(item);
  }
}

function renderNavigation() {
  const isOwner = appState.access.principal?.role === "owner";
  const allowed = ["player", "library", "effects", "playlists", "settings", "studio", ...(isOwner ? ["sharing"] : [])];
  if (!allowed.includes(appState.view)) appState.view = "player";
  document.querySelectorAll("[data-view]").forEach((link) => {
    const active = link.dataset.view === appState.view;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-view-panel]").forEach((panel) =>
    panel.classList.toggle("active", panel.dataset.viewPanel === appState.view));
}

function applyAccess(access) {
  appState.access = access;
  renderAccess();
  renderNavigation();
}

function renderAccess() {
  const principal = appState.access.principal;
  const isOwner = principal?.role === "owner";
  elements["sharing-nav"].hidden = !isOwner;
  document.getElementById("diagnostics-panel").hidden = !isOwner;

  elements["open-token"].hidden = Boolean(appState.access.csrfToken);
  elements["open-token"].textContent = principal ? "Acesso local" : "Acesso ao painel";

  if (!isOwner) return;
  const enabled = appState.access.remoteAccessEnabled && Boolean(appState.access.publicUrl);
  elements["remote-status-dot"].classList.toggle("connected", enabled);
  elements["remote-status-title"].textContent = enabled
    ? "Compartilhamento configurado"
    : "Acesso remoto desligado";
  elements["remote-status-detail"].textContent = enabled
    ? "Convites usam uma conexão HTTPS e podem ser revogados a qualquer momento."
    : "Defina PUBLIC_URL, REMOTE_ACCESS_ENABLED=true e inicie o túnel para criar convites.";
  elements["invite-name"].disabled = !enabled;
  elements["create-invite"].disabled = !enabled;
  const publicUrl = elements["remote-public-url"];
  publicUrl.hidden = !enabled;
  publicUrl.textContent = appState.access.publicUrl || "";
  publicUrl.href = appState.access.publicUrl || "#";
  renderAccessManagement();
}

function renderAccessManagement() {
  const collaborators = appState.accessManagement.collaborators
    .filter(({ status }) => status === "active");
  const invitations = appState.accessManagement.invitations
    .filter(({ status }) => status === "pending");

  elements["collaborator-list"].replaceChildren();
  elements["collaborator-empty"].hidden = collaborators.length > 0;
  for (const collaborator of collaborators) {
    const item = document.createElement("article");
    item.className = "access-list-item";
    item.innerHTML = `
      <span class="access-avatar">${escapeHtml(collaborator.displayName.slice(0, 1).toUpperCase())}</span>
      <span><strong>${escapeHtml(collaborator.displayName)}</strong><small>Ativo${collaborator.lastSeenAt ? ` · visto ${formatDate(collaborator.lastSeenAt)}` : ""}</small></span>
      <button class="danger-button compact-button" type="button">Revogar</button>`;
    item.querySelector("button").addEventListener("click", () => revokeCollaborator(collaborator));
    window.sonoraSharing?.editAccess(item, collaborator);
    elements["collaborator-list"].append(item);
  }

  elements["invitation-list"].replaceChildren();
  elements["invitation-empty"].hidden = invitations.length > 0;
  for (const invitation of invitations) {
    const item = document.createElement("article");
    item.className = "access-list-item";
    item.innerHTML = `
      <span class="access-avatar pending">⌁</span>
      <span><strong>${escapeHtml(invitation.displayName)}</strong><small>Expira ${formatDate(invitation.expiresAt)}</small></span>
      <button class="secondary-button compact-button" type="button">Cancelar</button>`;
    item.querySelector("button").addEventListener("click", () => revokeInvitation(invitation));
    const pendingCollaborator = appState.accessManagement.collaborators.find(item => item.id === invitation.collaboratorId);
    if (pendingCollaborator) window.sonoraSharing?.editAccess(item, pendingCollaborator);
    elements["invitation-list"].append(item);
  }
}

async function loadAccessManagement() {
  if (appState.access.principal?.role !== "owner") return;
  const result = await api("/api/access");
  appState.access.remoteAccessEnabled = result.remoteAccessEnabled;
  appState.access.publicUrl = result.publicUrl;
  appState.accessManagement = {
    collaborators: result.collaborators || [],
    invitations: result.invitations || [],
  };
  renderAccess();
}

async function revokeInvitation(invitation) {
  if (!window.confirm(`Cancelar o convite de “${invitation.displayName}”?`)) return;
  try {
    const result = await api(`/api/access/invitations/${invitation.id}`, { method: "DELETE" });
    appState.accessManagement = result;
    renderAccessManagement();
    showToast("Convite cancelado.");
  } catch (error) { showToast(error.message, true); }
}

async function revokeCollaborator(collaborator) {
  if (!window.confirm(`Revogar agora o acesso de “${collaborator.displayName}”?`)) return;
  try {
    const result = await api(`/api/access/collaborators/${collaborator.id}`, { method: "DELETE" });
    appState.accessManagement = result;
    renderAccessManagement();
    showToast("Acesso revogado imediatamente.");
  } catch (error) { showToast(error.message, true); }
}

function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function openTrackEditor(track) {
  elements["track-id"].value = track.id;
  elements["track-title-input"].value = track.title;
  elements["track-artist-input"].value = track.artist || "";
  elements["track-album-input"].value = track.album || "";
  elements["track-category-input"].value = track.category;
  elements["track-file-hint"].textContent = track.relativePath;
  elements["track-file-hint"].title = track.relativePath;
  elements["track-dialog"].showModal();
}

function openPlaylistEditor(playlist = null, initialTrack = null) {
  elements["playlist-id"].value = playlist?.id || "";
  elements["playlist-form"].dataset.initialTrackId = initialTrack?.id || "";
  document.getElementById("playlist-initial-track").textContent = initialTrack ? `Áudio inicial: ${initialTrack.title}` : "";
  elements["playlist-dialog-title"].textContent = playlist ? "Editar playlist" : "Nova playlist";
  elements["playlist-name-input"].value = playlist?.name || "";
  elements["playlist-description-input"].value = playlist?.description || "";
  elements["delete-playlist-button"].hidden = !playlist;
  elements["playlist-dialog"].showModal();
  elements["playlist-name-input"].focus();
}

function openPlaylistPicker(track) {
  if (!appState.playlists.length) {
    openPlaylistEditor(null, track);
    return;
  }
  const select = elements["playlist-picker-select"];
  select.replaceChildren();
  for (const playlist of appState.playlists) {
    select.add(new Option(playlist.name, playlist.id));
  }
  select.value = appState.selectedPlaylistId || appState.playlists[0].id;
  elements["playlist-track-id"].value = track.id;
  elements["playlist-picker-title"].textContent = track.title;
  elements["playlist-picker-dialog"].showModal();
}

async function sessionAction(action, value) {
  const session = activeSession();
  if (!session) return showToast("Chame o bot pelo Discord primeiro.", true);
  try {
    await api(`/api/sessions/${session.guildId}/actions`, {
      method: "POST",
      body: JSON.stringify(value === undefined ? { action } : { action, value }),
    });
  } catch (error) { showToast(error.message, true); }
}

function scheduleVolume(action, prefix, value) {
  const session = activeSession();
  if (!session) return;
  const key = `${session.guildId}/${action}`;
  clearTimeout(pendingVolumes.get(key)?.timer);
  const generation = sessionGeneration;
  const pending = { value, timer: setTimeout(async () => {
    try {
      const updated = await api(`/api/sessions/${session.guildId}/actions`, {
        method: "POST", body: JSON.stringify({ action, value }),
      });
      if (generation === sessionGeneration && pendingVolumes.get(key) === pending) {
        const latest = appState.sessions.find(item => item.guildId === session.guildId);
        if (latest) latest[action] = updated[action];
      }
    } catch (error) { if (generation === sessionGeneration) showToast(error.message, true); }
    finally {
      if (pendingVolumes.get(key) === pending) {
        pendingVolumes.delete(key);
        if (activeSession()?.guildId === session.guildId) {
          renderVolume(action, prefix, activeSession(), action === "volume" ? 70 : 100);
          window.sonoraSharing?.permissions();
        }
      }
    }
  }, 180) };
  pendingVolumes.set(key, pending);
  elements[`${prefix}-output`].textContent = `${value}%`;
}

async function enqueue(trackId, position) {
  const session = activeSession();
  if (!session?.voiceChannelId) return showToast("Use /play ou /join no Discord para iniciar uma sessão.", true);
  try {
    await api(`/api/sessions/${session.guildId}/queue`, {
      method: "POST",
      body: JSON.stringify({ trackId, position }),
    });
    showToast(position === "next" ? "Áudio colocado como próximo." : "Áudio adicionado à fila.");
  } catch (error) { showToast(error.message, true); }
}

async function enqueueBatch(trackIds, shuffle) {
  const session = activeSession();
  if (!session?.voiceChannelId) {
    return showToast("Use /play ou /join no Discord para iniciar uma sessão.", true);
  }
  if (!trackIds.length) return;
  try {
    const result = await api(`/api/sessions/${session.guildId}/queue/batch`, {
      method: "POST",
      body: JSON.stringify({ trackIds, shuffle }),
    });
    const audioLabel = result.added === 1 ? "áudio adicionado" : "áudios adicionados";
    showToast(`${result.added} ${audioLabel} à fila${shuffle ? " em ordem aleatória" : ""}.`);
  } catch (error) { showToast(error.message, true); }
}

async function enqueueExternal(url) {
  const session = activeSession();
  if (!session?.voiceChannelId) return showToast("Use /play ou /join no Discord para iniciar uma sessão.", true);
  const form = elements["external-form"];
  if (form.dataset.pending === "true") return;
  const generation = sessionGeneration;
  form.dataset.pending = "true";
  elements["external-add"].disabled = true;
  elements["external-add"].textContent = "Resolvendo…";
  try {
    await api(`/api/sessions/${session.guildId}/queue/external`, {
      method: "POST",
      body: JSON.stringify({ url, position: "end" }),
    });
    if (elements["external-url"].value.trim() === url) elements["external-url"].value = "";
    showToast("Link resolvido e adicionado à fila.");
  } catch (error) { if (generation === sessionGeneration) showToast(error.message, true); }
  finally {
    if (generation === sessionGeneration) {
      delete form.dataset.pending;
      elements["external-add"].textContent = "Adicionar à fila";
      updateSourceControls();
      window.sonoraSharing?.permissions();
    }
  }
}

async function playEffect(trackId) {
  const session = activeSession();
  if (!session?.voiceChannelId) return showToast("Use /play ou /join no Discord para iniciar uma sessão.", true);
  try {
    await api(`/api/sessions/${session.guildId}/effects`, {
      method: "POST",
      body: JSON.stringify({ trackId }),
    });
    showToast("Efeito disparado sobre a música.");
  } catch (error) { showToast(error.message, true); }
}

async function queuePlaylist() {
  const session = activeSession();
  const playlist = selectedPlaylist();
  if (!session?.voiceChannelId) return showToast("Use /play ou /join no Discord para iniciar uma sessão.", true);
  if (!playlist) return;
  try {
    const result = await api(`/api/sessions/${session.guildId}/playlists/${playlist.id}`, { method: "POST" });
    showToast(`${result.added} ${result.added === 1 ? "áudio adicionado" : "áudios adicionados"} à fila.`);
  } catch (error) { showToast(error.message, true); }
}

async function removeQueueItem(index) {
  const session = activeSession();
  if (!session) return;
  try { await api(`/api/sessions/${session.guildId}/queue/${index}`, { method: "DELETE" }); }
  catch (error) { showToast(error.message, true); }
}

async function playQueueItem(index) {
  const session = activeSession();
  const track = session?.upcoming[index];
  if (!session || !track) return;
  try {
    await api(`/api/sessions/${session.guildId}/queue/${index}/play`, { method: "POST" });
    showToast(`Tocando agora: ${track.title}`);
  } catch (error) { showToast(error.message, true); }
}

async function reorderQueue(from, to) {
  const session = activeSession();
  if (!session) return;
  try {
    await api(`/api/sessions/${session.guildId}/queue`, {
      method: "PATCH",
      body: JSON.stringify({ from, to }),
    });
  } catch (error) { showToast(error.message, true); }
}

async function removePlaylistItem(itemId) {
  const playlist = selectedPlaylist();
  if (!playlist) return;
  try {
    const result = await api(`/api/playlists/${playlist.id}/items/${itemId}`, { method: "DELETE" });
    applyPlaylists(result.playlists);
    showToast("Item removido da playlist.");
  } catch (error) { showToast(error.message, true); }
}

async function reorderPlaylistItem(from, to) {
  const playlist = selectedPlaylist();
  if (!playlist) return;
  try {
    const result = await api(`/api/playlists/${playlist.id}/items`, {
      method: "PATCH",
      body: JSON.stringify({ from, to }),
    });
    applyPlaylists(result.playlists);
  } catch (error) { showToast(error.message, true); }
}

async function addTrackToPlaylist(trackId, playlistId) {
  const result = await api(`/api/playlists/${playlistId}/items`, {
    method: "POST",
    body: JSON.stringify({ trackId }),
  });
  appState.selectedPlaylistId = playlistId;
  applyPlaylists(result.playlists);
}

async function uploadFile(file) {
  if (!file) return;
  const body = new FormData();
  body.append("file", file);
  showToast("Enviando e analisando o áudio…");
  try {
    const folder = appState.uploadCategory === "music" ? appState.musicFolder : appState.effectFolder;
    const result = await api(`/api/library/upload?category=${appState.uploadCategory}&folder=${encodeURIComponent(folder === "." ? "" : folder)}`, { method: "POST", body });
    appState.library = result.tracks;
    renderLibrary();
    showToast("Áudio adicionado à biblioteca.");
  } catch (error) { showToast(error.message, true); }
  elements["file-input"].value = "";
}

function showToast(message, error = false) {
  const dialog = error ? Array.from(document.querySelectorAll("dialog[open]")).at(-1) : null;
  if (dialog) {
    let feedback = dialog.querySelector(".dialog-feedback");
    if (!feedback) {
      feedback = document.createElement("p");
      feedback.className = "dialog-feedback";
      feedback.setAttribute("role", "alert");
      (dialog.querySelector("form") || dialog).append(feedback);
      dialog.addEventListener("close", () => feedback.remove(), { once: true });
    }
    feedback.textContent = message;
    feedback.scrollIntoView({ block: "nearest" });
    return;
  }
  const toast = document.createElement("div");
  toast.className = `toast${error ? " error" : ""}`;
  toast.textContent = message;
  elements["toast-region"].append(toast);
  setTimeout(() => toast.remove(), 4200);
}

function formatDuration(milliseconds = 0) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatLongDuration(milliseconds = 0) {
  if (milliseconds < 60_000) return formatDuration(milliseconds);
  const totalMinutes = Math.round(milliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h${minutes ? ` ${minutes}min` : ""}` : `${minutes}min`;
}

function statusLabel(status) {
  return ({ idle: "Ocioso", buffering: "Carregando", playing: "Tocando", paused: "Pausado", error: "Com erro" })[status] || status;
}

function loopLabel(mode) {
  return ({ off: "Sem loop", track: "Faixa", queue: "Fila" })[mode] || "Sem loop";
}

function friendlyPlaybackError(message) {
  if (/Cannot find module.+opus|Opus Libraries.+not found/is.test(message)) {
    return "O codificador Opus não está disponível. Instale as dependências e reinicie o Sonora.";
  }
  if (/ffmpeg|ffprobe/i.test(message)) {
    return "O FFmpeg não conseguiu processar este arquivo. Verifique a instalação e o formato do áudio.";
  }
  if (/HTTP Error 403|PO Token|Sign in to confirm/i.test(message)) {
    return "O YouTube recusou esta transmissão. Tente outro vídeo ou configure YTDLP_COOKIES_FILE.";
  }
  return `Falha na reprodução: ${String(message).split("\n")[0].replace(/^Error:\s*/, "")}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

elements["guild-select"].addEventListener("change", (event) => {
  appState.selectedGuildId = event.target.value;
  sessionStorage.setItem("sonora:guild", appState.selectedGuildId);
  render();
});
elements["play-pause-button"].addEventListener("click", () =>
  sessionAction(activeSession()?.status === "paused" ? "resume" : "pause"));
elements["stop-button"].addEventListener("click", () => sessionAction("stop"));
elements["skip-button"].addEventListener("click", () => sessionAction("skip"));
elements["leave-button"].addEventListener("click", () => sessionAction("leave"));
elements["clear-queue"].addEventListener("click", () => sessionAction("clear"));
elements["loop-button"].addEventListener("click", () => {
  const modes = ["off", "track", "queue"];
  const current = activeSession()?.repeatMode || "off";
  sessionAction("loop", modes[(modes.indexOf(current) + 1) % modes.length]);
});
elements["volume-input"].addEventListener("input", (event) => scheduleVolume("volume", "volume", Number(event.target.value)));
elements["effect-volume-input"].addEventListener("input", (event) => scheduleVolume("effectVolume", "effect-volume", Number(event.target.value)));
elements["external-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  enqueueExternal(elements["external-url"].value.trim());
});
elements["scan-button"].addEventListener("click", async () => {
  const button = elements["scan-button"];
  button.disabled = true;
  button.textContent = "Reindexando…";
  try {
    const result = await api("/api/library/scan", { method: "POST" });
    appState.library = result.tracks;
    renderLibrary();
    renderPlaylists();
    showToast("Biblioteca atualizada.");
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; button.textContent = "Reindexar pasta"; }
});
elements["library-search"].addEventListener("input", renderLibrary);
for (const id of ["music-folder-play-all", "effect-folder-play-all"]) {
  elements[id].addEventListener("click", () => {
    const trackIds = elements[id].dataset.trackIds?.split(",").filter(Boolean) || [];
    enqueueBatch(trackIds, false);
  });
}
for (const id of ["music-folder-shuffle", "effect-folder-shuffle"]) {
  elements[id].addEventListener("click", () => {
    const trackIds = elements[id].dataset.trackIds?.split(",").filter(Boolean) || [];
    enqueueBatch(trackIds, true);
  });
}
for (const id of ["library-playlist-filter", "effects-playlist-filter"]) {
  elements[id].addEventListener("change", (event) => {
    appState.filterPlaylistId = event.target.value;
    if (appState.filterPlaylistId) {
      sessionStorage.setItem("sonora:playlist-filter", appState.filterPlaylistId);
    } else {
      sessionStorage.removeItem("sonora:playlist-filter");
    }
    renderLibrary();
  });
}
elements["upload-music-button"].addEventListener("click", () => {
  appState.uploadCategory = "music";
  elements["file-input"].click();
});
elements["upload-effect-button"].addEventListener("click", () => {
  appState.uploadCategory = "effect";
  elements["file-input"].click();
});
elements["file-input"].addEventListener("change", (event) => window.sonoraStudio?.upload([...event.target.files]));
elements["new-playlist-button"].addEventListener("click", () => openPlaylistEditor());
elements["edit-playlist-button"].addEventListener("click", () => {
  const playlist = selectedPlaylist();
  if (playlist) openPlaylistEditor(playlist);
});
elements["queue-playlist-button"].addEventListener("click", queuePlaylist);

elements["track-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const trackId = elements["track-id"].value;
  try {
    const result = await api(`/api/library/${trackId}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: elements["track-title-input"].value.trim(),
        artist: elements["track-artist-input"].value.trim() || null,
        album: elements["track-album-input"].value.trim() || null,
        category: elements["track-category-input"].value,
      }),
    });
    appState.library = result.tracks;
    elements["track-dialog"].close();
    renderLibrary();
    renderPlaylists();
    showToast("Áudio atualizado.");
  } catch (error) { showToast(error.message, true); }
});

elements["delete-track-button"].addEventListener("click", async () => {
  const track = trackById(elements["track-id"].value);
  if (!track) return;
  const confirmed = window.confirm(`Mover “${track.title}” para a lixeira? Você poderá restaurar o arquivo e sua participação nas playlists.`);
  if (!confirmed) return;
  try {
    const result = await api(`/api/library/${track.id}`, { method: "DELETE" });
    appState.library = result.tracks;
    elements["track-dialog"].close();
    applyPlaylists(result.playlists);
    showToast("Áudio movido para a lixeira.");
    window.sonoraStudio?.refresh();
  } catch (error) { showToast(error.message, true); }
});

elements["playlist-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const playlistId = elements["playlist-id"].value;
  const initialTrackId = playlistId ? "" : elements["playlist-form"].dataset.initialTrackId;
  const submit = elements["playlist-form"].querySelector('button[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  const body = JSON.stringify({
    name: elements["playlist-name-input"].value.trim(),
    description: elements["playlist-description-input"].value.trim() || null,
    ...(initialTrackId ? { trackId: initialTrackId } : {}),
  });
  try {
    const result = await api(playlistId ? `/api/playlists/${playlistId}` : "/api/playlists", {
      method: playlistId ? "PATCH" : "POST",
      body,
    });
    appState.selectedPlaylistId = result.playlist.id;
    elements["playlist-dialog"].close();
    applyPlaylists(result.playlists);
    showToast(initialTrackId ? "Playlist criada e áudio adicionado." : playlistId ? "Playlist atualizada." : "Playlist criada.");
  } catch (error) { showToast(error.message, true); }
  finally { submit.disabled = false; }
});

elements["delete-playlist-button"].addEventListener("click", async () => {
  const playlist = appState.playlists.find(({ id }) => id === elements["playlist-id"].value);
  if (!playlist || !window.confirm(`Excluir a playlist “${playlist.name}”? Os arquivos de áudio serão mantidos.`)) return;
  try {
    const result = await api(`/api/playlists/${playlist.id}`, { method: "DELETE" });
    elements["playlist-dialog"].close();
    applyPlaylists(result.playlists);
    showToast("Playlist excluída. Seus áudios foram mantidos.");
  } catch (error) { showToast(error.message, true); }
});

elements["playlist-picker-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await addTrackToPlaylist(
      elements["playlist-track-id"].value,
      elements["playlist-picker-select"].value,
    );
    elements["playlist-picker-dialog"].close();
    showToast("Áudio adicionado à playlist.");
  } catch (error) { showToast(error.message, true); }
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => document.getElementById(button.dataset.closeDialog).close());
});

elements["open-token"].addEventListener("click", () => {
  if (!appState.access.principal) {
    elements["token-input"].value = "";
    elements["token-dialog"].showModal();
    return;
  }
  if (!appState.access.csrfToken && !appState.access.remoteAccessEnabled) {
    showToast("Este painel está disponível somente neste computador.");
    return;
  }
  logout();
});
const tokenDialog = elements["token-dialog"];
const tokenError = document.getElementById("token-error");
tokenDialog.addEventListener("cancel", event => { if (elements["app-shell"].hidden) event.preventDefault(); });
elements["token-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = elements["token-form"].querySelector('button[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  tokenError.textContent = "";
  try {
    const result = await api("/api/auth/owner", {
      method: "POST",
      body: JSON.stringify({ token: elements["token-input"].value.trim() }),
    }, false);
    applyAccess(result.access);
    elements["token-input"].value = "";
    await loadDashboard();
    tokenDialog.close();
  } catch (error) { tokenError.textContent = error.message; }
  finally { submit.disabled = false; }
});

elements["invite-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = elements["create-invite"];
  button.disabled = true;
  try {
    const result = await api("/api/access/invitations", {
      method: "POST",
      body: JSON.stringify({ displayName: elements["invite-name"].value.trim(), ...window.sonoraSharing?.invitationPolicy() }),
    });
    appState.accessManagement = {
      collaborators: result.collaborators,
      invitations: result.invitations,
    };
    elements["invite-name"].value = "";
    elements["generated-invite-url"].value = result.invitation.url;
    elements["generated-invite"].hidden = false;
    renderAccessManagement();
    showToast("Convite criado. O link expira em 24 horas.");
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = !appState.access.remoteAccessEnabled; }
});

elements["copy-invite"].addEventListener("click", async () => {
  const invitationUrl = elements["generated-invite-url"].value;
  try {
    await navigator.clipboard.writeText(invitationUrl);
  } catch {
    elements["generated-invite-url"].select();
    if (!document.execCommand("copy")) return showToast("Selecione e copie o link manualmente.", true);
  }
  showToast("Link copiado.");
});

elements["accept-invite"].addEventListener("click", async () => {
  if (!appState.invitationToken) return;
  elements["accept-invite"].disabled = true;
  try {
    const result = await api(
      `/api/auth/invitations/${encodeURIComponent(appState.invitationToken)}/redeem`,
      { method: "POST" },
      false,
    );
    applyAccess(result.access);
    history.replaceState({}, "", "/#player");
    appState.view = "player";
    elements["invite-gate"].hidden = true;
    elements["app-shell"].hidden = false;
    await loadDashboard();
    showToast(`Bem-vindo, ${result.access.principal.displayName}.`);
  } catch (error) {
    elements["invite-error"].textContent = error.message;
    elements["invite-error"].hidden = false;
  }
});

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (error) {
    showToast(error.message, true);
    return;
  }
  if (appState.access.authenticated) endSession();
}

function endSession(notify = true) {
  sessionGeneration++;
  events?.close(); events = null;
  for (const pending of pendingVolumes.values()) clearTimeout(pending.timer);
  pendingVolumes.clear();
  draggedEntry = null;
  appState.library = []; appState.sessions = []; appState.playlists = [];
  appState.accessManagement = { collaborators: [], invitations: [] };
  appState.bot = { configured: false, connected: false, username: null };
  appState.selectedGuildId = ""; appState.selectedPlaylistId = ""; appState.filterPlaylistId = "";
  for (const key of ["sonora:guild", "sonora:playlist", "sonora:playlist-filter"]) sessionStorage.removeItem(key);
  appState.access = {
    authenticated: false,
    principal: null,
    csrfToken: null,
    remoteAccessEnabled: false,
    publicUrl: null,
  };
  window.sonoraStudio?.reset(); window.sonoraSharing?.reset();
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  for (const form of document.querySelectorAll("form")) form.reset();
  elements["generated-invite-url"].value = "";
  elements["generated-invite"].hidden = true;
  delete elements["external-form"].dataset.pending;
  elements["external-add"].textContent = "Adicionar à fila";
  tokenError.textContent = notify ? "Sessão encerrada. Entre novamente para acessar o painel." : "";
  elements["app-shell"].hidden = true;
  render();
  if (!elements["token-dialog"].open) elements["token-dialog"].showModal();
}

async function loadDashboard() {
  const state = await api("/api/state");
  applyFullState(state);
  elements["app-shell"].hidden = false;
  connectEvents();
  if (appState.access.principal?.role === "owner") {
    await loadAccessManagement();
  }
}

async function openInvitation(invitationToken) {
  appState.invitationToken = invitationToken;
  elements["app-shell"].hidden = true;
  elements["invite-gate"].hidden = false;
  try {
    const preview = await api(
      `/api/auth/invitations/${encodeURIComponent(invitationToken)}`,
      {},
      false,
    );
    elements["invite-title"].textContent = `${preview.displayName}, você recebeu acesso ao Sonora`;
    elements["invite-copy"].textContent = `Este convite expira em ${formatDate(preview.expiresAt)}. Perfil: ${{ full: "controle completo de áudio", playback: "somente reprodução", effects: "somente efeitos" }[preview.profile || "full"]}${preview.guildIds != null ? " · limitado a servidores específicos" : ""}.`;
    elements["accept-invite"].disabled = false;
  } catch (error) {
    elements["invite-copy"].textContent = "Não foi possível abrir este convite.";
    elements["invite-error"].textContent = error.message;
    elements["invite-error"].hidden = false;
  }
}

async function bootstrap() {
  sessionStorage.removeItem("sonora:token");
  const invitationMatch = location.pathname.match(/^\/invite\/([^/]+)\/?$/);
  if (invitationMatch) {
    await openInvitation(invitationMatch[1]);
    return;
  }

  try {
    const result = await api("/api/auth/session", {}, false);
    applyAccess(result.access);
    await loadDashboard();
  } catch {
    if (!elements["token-dialog"].open) elements["token-dialog"].showModal();
  }
}

window.addEventListener("hashchange", () => {
  const previousView = appState.view;
  appState.view = location.hash.slice(1) || "player";
  renderNavigation();
  if (appState.view !== previousView) window.scrollTo({ top: 0, behavior: "instant" });
});

setInterval(renderProgress, 1_000);
bootstrap();
