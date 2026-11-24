(() => {
  const defaults = { accent: "#ff6b35", background: "#0a090d", surface: "#131217", ink: "#f8f5ef", muted: "#a9a5b1" };
  const labels = { accent: "Destaque", background: "Fundo", surface: "Painéis", ink: "Texto principal", muted: "Texto secundário" };
  let theme = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem("sonora:theme") || "{}");
    for (const key of Object.keys(defaults)) {
      if (/^#[0-9a-f]{6}$/i.test(saved?.[key])) theme[key] = saved[key];
    }
  } catch { /* A blocked or invalid preference must not prevent startup. */ }
  const fields = new Map();
  function accentTextColor(background) {
    const [red, green, blue] = background.slice(1).match(/../g).map(part => {
      const channel = parseInt(part, 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
  }
  const apply = () => {
    for (const [key, value] of Object.entries(theme)) document.documentElement.style.setProperty(`--${key}`, value);
    document.documentElement.style.setProperty("--accent-soft", theme.accent);
    document.documentElement.style.setProperty("--surface-raised", `color-mix(in srgb, ${theme.surface} 92%, ${theme.ink})`);
    document.documentElement.style.setProperty("--line", `color-mix(in srgb, ${theme.surface} 78%, ${theme.ink})`);
    document.documentElement.style.setProperty("--faint", theme.muted);
    document.documentElement.style.setProperty("--accent-ink", accentTextColor(theme.accent));
  };
  const save = () => {
    apply();
    try {
      localStorage.setItem("sonora:theme", JSON.stringify(theme));
      document.getElementById("theme-feedback").textContent = "Cores salvas neste navegador.";
    } catch { document.getElementById("theme-feedback").textContent = "Cores aplicadas. O navegador não permitiu salvá-las."; }
  };
  for (const key of Object.keys(defaults)) {
    const label = document.createElement("label");
    label.textContent = labels[key];
    const input = document.createElement("input");
    input.type = "color";
    input.setAttribute("aria-label", labels[key]);
    input.value = theme[key];
    input.addEventListener("input", () => { theme[key] = input.value; save(); });
    fields.set(key, input);
    label.append(input);
    document.getElementById("theme-colors").append(label);
  }
  document.getElementById("theme-reset").addEventListener("click", () => {
    theme = { ...defaults };
    for (const [key, input] of fields) input.value = theme[key];
    save();
  });
  apply();

  document.getElementById("diagnostics-run").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const output = document.getElementById("diagnostics-result");
    button.disabled = true;
    output.textContent = "Verificando…";
    try {
      const result = await api("/api/diagnostics");
      output.textContent = [
        `API do Discord: ${result.discordReachable ? "acessível" : "indisponível"}`,
        `Bot: ${result.bot.connected ? "conectado" : "desconectado"}`,
        `Comandos: ${result.bot.commandsRegistered ? "registrados" : "pendentes"}`,
        ...result.checks.map((check) => `${check.name}: ${check.available ? "disponível" : "não disponível"}`),
      ].join(" · ");
    } catch (error) { output.textContent = error.message; }
    finally { button.disabled = false; }
  });

  let lastScan = "";
  async function pollScan() {
    try {
      if (!appState.access.authenticated) return;
      const result = await api("/api/library/status", {}, false);
      const signature = JSON.stringify(result);
      if (signature === lastScan) return;
      document.getElementById("scan-progress").textContent = `${result.running ? "Indexando" : "Indexação concluída"}: ${result.processed}/${result.total} arquivos. ${result.errors.length} com problemas.`;
      const errors = document.getElementById("scan-errors");
      errors.replaceChildren();
      for (const error of result.errors) {
        const item = document.createElement("li");
        item.textContent = `${error.file}: ${error.message}`;
        errors.append(item);
      }
      if (!result.running && events?.readyState !== EventSource.OPEN) applyFullState(await api("/api/state", {}, false));
      lastScan = signature;
    } catch { /* Retry after a transient server restart. */ }
    finally { setTimeout(pollScan, 3_000); }
  }
  void pollScan();
})();
