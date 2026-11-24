import "dotenv/config";

import { spawnSync } from "node:child_process";

const action = process.argv[2] || "status";
const port = Number(process.env.PORT || 3210);
const localTarget = `http://127.0.0.1:${port}`;

function run(args, options = {}) {
  const result = spawnSync("tailscale", args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error?.code === "ENOENT") {
    console.error("Tailscale não está instalado. Consulte https://tailscale.com/download");
    process.exit(1);
  }
  if (result.status !== 0) {
    if (options.capture && result.stderr) console.error(result.stderr.trim());
    process.exit(result.status || 1);
  }
  return result.stdout || "";
}

function detectedPublicUrl() {
  const rawStatus = run(["status", "--json"], { capture: true });
  const status = JSON.parse(rawStatus);
  const dnsName = String(status.Self?.DNSName || "").replace(/\.$/, "");
  return dnsName ? `https://${dnsName}` : "";
}

if (action === "status") {
  const publicUrl = detectedPublicUrl();
  if (publicUrl) console.log(`URL esperada no .env: ${publicUrl}`);
  run(["funnel", "status"]);
} else if (action === "start") {
  if (process.env.REMOTE_ACCESS_ENABLED !== "true") {
    console.error("Defina REMOTE_ACCESS_ENABLED=true no .env antes de compartilhar.");
    process.exit(1);
  }
  if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.trim().length < 32) {
    console.error("ADMIN_TOKEN precisa ter pelo menos 32 caracteres no acesso remoto.");
    process.exit(1);
  }

  const publicUrl = detectedPublicUrl();
  const configuredUrl = String(process.env.PUBLIC_URL || "").replace(/\/+$/, "");
  if (!publicUrl || configuredUrl !== publicUrl) {
    console.error(`Defina PUBLIC_URL=${publicUrl || "https://nome-da-maquina.seu-tailnet.ts.net"} no .env.`);
    process.exit(1);
  }

  try {
    const response = await fetch(`${localTarget}/api/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    console.error(`O Sonora não respondeu em ${localTarget}. Inicie-o com npm start primeiro.`);
    process.exit(1);
  }

  run(["funnel", "--bg", "--yes", "--https=443", localTarget]);
  console.log(`Painel publicado em ${publicUrl}`);
} else if (action === "stop") {
  run(["funnel", "--https=443", "off"]);
  console.log("Compartilhamento remoto interrompido.");
} else {
  console.error("Ação desconhecida. Use start, status ou stop.");
  process.exit(1);
}
