const test = require("node:test");
const assert = require("node:assert/strict");

const { createServer } = require("../modules/registry");
const { MODULES } = require("../modules/status");

test("createServer() ne lève pas et enregistre au moins un tool", () => {
  const server = createServer();
  const registered = Object.keys(server._registeredTools);
  assert.ok(registered.length > 0, "aucun tool enregistré");
});

test("chaque tool déclaré dans MODULES (status.js) est bien enregistré par createServer()", () => {
  const server = createServer();
  const registered = new Set(Object.keys(server._registeredTools));
  const declared = MODULES.flatMap((m) => m.tools);

  const missing = declared.filter((name) => !registered.has(name));
  assert.deepEqual(missing, [], `tools déclarés dans status.js mais absents du registry: ${missing.join(", ")}`);
});

test("MODULES (status.js) référence bien tous les tools enregistrés par createServer()", () => {
  const server = createServer();
  const registered = Object.keys(server._registeredTools);
  const declared = new Set(MODULES.flatMap((m) => m.tools));

  const undeclared = registered.filter((name) => !declared.has(name));
  assert.deepEqual(undeclared, [], `tools enregistrés mais absents de status.js: ${undeclared.join(", ")}`);
});
