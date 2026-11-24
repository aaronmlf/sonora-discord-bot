import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("mantem o painel local sem exigir token", () => {
    const config = loadConfig({
      HOST: "127.0.0.1",
      PORT: "4321",
      ADMIN_TOKEN: "",
      DISCORD_TOKEN: "",
      DISCORD_CLIENT_ID: "   ",
      DISCORD_GUILD_ID: "",
    });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 4321);
    assert.equal(config.defaultEffectVolume, 100);
    assert.equal(config.remoteAccessEnabled, false);
    assert.equal(config.adminToken, undefined);
    assert.equal(config.discordToken, undefined);
    assert.equal(config.discordClientId, undefined);
    assert.equal(config.discordGuildId, undefined);
  });

  it("exige token quando o painel e exposto na rede", () => {
    assert.throws(
      () => loadConfig({ HOST: "0.0.0.0" }),
      /ADMIN_TOKEN deve ser definido/,
    );
  });

  it("aceita exposicao na rede quando ha token forte", () => {
    const config = loadConfig({
      HOST: "0.0.0.0",
      ADMIN_TOKEN: "um-token-com-mais-de-doze-caracteres",
    });
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.adminToken, "um-token-com-mais-de-doze-caracteres");
  });

  it("exige token mais forte e URL HTTPS no acesso remoto", () => {
    assert.throws(
      () => loadConfig({ REMOTE_ACCESS_ENABLED: "true", ADMIN_TOKEN: "curto" }),
      /Too small|pelo menos 32/,
    );
    assert.throws(
      () => loadConfig({
        REMOTE_ACCESS_ENABLED: "true",
        ADMIN_TOKEN: "a".repeat(32),
        PUBLIC_URL: "http://exemplo.test",
      }),
      /PUBLIC_URL deve ser uma origem HTTPS valida/,
    );
  });

  it("aceita o acesso remoto configurado com HTTPS", () => {
    const config = loadConfig({
      REMOTE_ACCESS_ENABLED: "true",
      ADMIN_TOKEN: "a".repeat(32),
      PUBLIC_URL: "https://sonora.example.ts.net/",
    });
    assert.equal(config.remoteAccessEnabled, true);
    assert.equal(config.publicUrl, "https://sonora.example.ts.net");
  });
});
