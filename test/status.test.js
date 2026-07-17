const test = require("node:test");
const assert = require("node:assert/strict");

const { MODULES, renderStatusPage } = require("../modules/status");

test("MODULES: chaque entrée a un nom, une liste de tools non vide et un requiredEnv", () => {
  for (const m of MODULES) {
    assert.equal(typeof m.name, "string");
    assert.ok(m.name.length > 0, `module sans nom: ${JSON.stringify(m)}`);
    assert.ok(Array.isArray(m.tools) && m.tools.length > 0, `${m.name}: tools vide`);
    assert.ok(Array.isArray(m.requiredEnv), `${m.name}: requiredEnv doit être un tableau`);
  }
});

test("MODULES: aucun nom de tool dupliqué entre modules", () => {
  const seen = new Map();
  for (const m of MODULES) {
    for (const tool of m.tools) {
      const owner = seen.get(tool);
      assert.ok(!owner, `tool "${tool}" déclaré à la fois dans "${owner}" et "${m.name}"`);
      seen.set(tool, m.name);
    }
  }
});

test("renderStatusPage() produit du HTML contenant les infos passées", () => {
  const html = renderStatusPage({
    version: "1.2.3",
    uptime: 42,
    startTime: "17/07/2026 10:00:00",
    publicUrl: "https://example.test",
    port: "3000",
    activeSessions: 2,
    oauthStats: { clients: 1, accessTokens: 3, refreshTokens: 1 },
    oauthProviders: [],
    gateSessionsCount: 5,
    modules: [
      {
        name: "Test Module",
        isConfigured: true,
        toolCount: 1,
        toolDetails: [{ name: "test_tool", description: "un outil de test" }],
        note: undefined,
        externalDep: undefined,
        privacy: undefined,
      },
    ],
  });

  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /v1\.2\.3/);
  assert.match(html, /Test Module/);
  assert.match(html, /test_tool/);
  assert.match(html, /✓ Configuré/);
});

test("renderStatusPage() échappe le HTML injecté dans les champs (XSS)", () => {
  const html = renderStatusPage({
    version: "1.0.0",
    uptime: 0,
    startTime: "17/07/2026 10:00:00",
    publicUrl: "<script>alert(1)</script>",
    port: "3000",
    activeSessions: 0,
    oauthStats: { clients: 0, accessTokens: 0, refreshTokens: 0 },
    oauthProviders: [],
    gateSessionsCount: 0,
    modules: [],
  });

  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
