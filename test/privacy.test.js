const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { registerPrivacyRoutes } = require("../modules/privacy");

async function withServer(fn) {
  const app = express();
  registerPrivacyRoutes(app);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /privacy répond 200 avec la politique générique", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/privacy`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Politique de confidentialité/);
  });
});

test("GET /privacy/:service connu répond avec la politique dédiée", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/privacy/facebook`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Intégration Facebook/);
  });
});

test("GET /privacy/:service inconnu retombe sur la politique générique (fallback)", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/privacy/service-inexistant`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /^\s*<!DOCTYPE html>/);
    assert.match(body, /Politique de confidentialité<\/title>/);
  });
});

test("GET /privacy/:service échappe le nom de service dans la page (anti-XSS)", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/privacy/${encodeURIComponent('"><script>alert(1)</script>')}`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(!body.includes("<script>alert(1)</script>"));
  });
});
