const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");

// Gate placé devant /authorize (avant mcpAuthRouter) : oauth.js auto-approuve
// tout ce qui atteint provider.authorize() (voir son commentaire), donc c'est
// ici, et seulement ici, que doit se faire la vraie vérification d'identité.
// Aucune autre route (/register, /token, /revoke) n'a besoin d'être protégée :
// elles sont inoffensives sans être jamais passé par /authorize au préalable.

const COOKIE_NAME = "francis_gate";
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 jours
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// Les sessions issues d'une passphrase validée sont persistées sur disque (mêmes
// garanties d'accès que data/google_token.json) : sans ça, le cookie francis_gate
// (valide 30 jours côté navigateur) ne correspondrait plus à rien côté serveur dès
// le premier redémarrage du process, et la passphrase serait redemandée pour rien.
const SESSIONS_STORE_PATH = path.join(__dirname, "..", "data", "gate_sessions.json");

function loadSessions() {
  const sessions = new Map(); // token -> expiresAtMs
  try {
    const stored = JSON.parse(fs.readFileSync(SESSIONS_STORE_PATH, "utf8"));
    const now = Date.now();
    for (const [token, expiresAt] of Object.entries(stored)) {
      if (typeof expiresAt === "number" && expiresAt > now) sessions.set(token, expiresAt);
    }
  } catch {
    // Pas de fichier, ou contenu invalide -> on démarre à vide.
  }
  return sessions;
}

function persistSessions(sessions) {
  try {
    fs.mkdirSync(path.dirname(SESSIONS_STORE_PATH), { recursive: true });
    fs.writeFileSync(SESSIONS_STORE_PATH, JSON.stringify(Object.fromEntries(sessions), null, 2));
  } catch (e) {
    process.stderr.write(`[authGate] Impossible de persister les sessions: ${e.message}\n`);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(header.split(";").map((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return [part.trim(), ""];
    return [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())];
  }));
}

function renderPage({ fields, showPassphrase, error, returnPath }) {
  const hidden = Object.entries(fields)
    .filter(([k]) => k !== "passphrase")
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(String(v))}">`)
    .join("\n      ");

  const clientId = fields.client_id ? escapeHtml(String(fields.client_id)) : "(inconnu)";
  let redirectHost = "(inconnu)";
  if (fields.redirect_uri) {
    try { redirectHost = escapeHtml(new URL(String(fields.redirect_uri)).host); }
    catch { redirectHost = escapeHtml(String(fields.redirect_uri)); }
  }

  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  const passphraseField = showPassphrase
    ? `<label>Passphrase<br><input type="password" name="passphrase" autofocus required></label><br><br>`
    : "";
  const buttonLabel = showPassphrase ? "Se connecter et autoriser" : "Autoriser";
  const action = returnPath ? escapeHtml(returnPath) : "/authorize";

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>Francis — Autorisation</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#0f1115; color:#e5e7eb; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  .box { background:#171a21; border:1px solid #262b35; border-radius:8px; padding:32px; max-width:420px; width:100%; box-sizing:border-box; }
  h1 { font-size:18px; margin:0 0 16px; }
  p { color:#8b93a3; font-size:14px; }
  p.error { color:#e05252; }
  input[type=password] { width:100%; padding:8px 10px; background:#0f1115; border:1px solid #262b35; color:#e5e7eb; border-radius:6px; box-sizing:border-box; }
  button { background:#25d366; border:none; color:#0f1115; font-weight:600; padding:10px 16px; border-radius:6px; cursor:pointer; margin-top:8px; }
</style>
</head>
<body>
  <div class="box">
    <h1>Autoriser l'accès</h1>
    <p>Client : <strong>${clientId}</strong><br>Redirection vers : <strong>${redirectHost}</strong></p>
    ${errorHtml}
    <form method="post" action="${action}">
      ${hidden}
      ${passphraseField}
      <button type="submit">${buttonLabel}</button>
    </form>
  </div>
</body></html>`;
}

function authGate({ passphrase }) {
  if (!passphrase) {
    throw new Error("authGate: passphrase manquante (MCP_GATE_PASSPHRASE)");
  }
  const expectedHash = crypto.createHash("sha256").update(passphrase).digest();
  const sessions = loadSessions(); // token -> expiresAtMs, persisté dans data/gate_sessions.json
  const attempts = new Map(); // ip -> { count, lockedUntil }

  function isLocked(ip) {
    const entry = attempts.get(ip);
    return !!(entry && entry.lockedUntil > Date.now());
  }
  function recordFailure(ip) {
    const entry = attempts.get(ip) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= MAX_ATTEMPTS) {
      entry.lockedUntil = Date.now() + LOCKOUT_MS;
      entry.count = 0;
    }
    attempts.set(ip, entry);
  }
  function recordSuccess(ip) {
    attempts.delete(ip);
  }

  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  router.all("/", (req, res, next) => {
    const cookies = parseCookies(req);
    const cookieToken = cookies[COOKIE_NAME];
    const sessionExpiresAt = cookieToken ? sessions.get(cookieToken) : undefined;
    const hasValidSession = !!(sessionExpiresAt && sessionExpiresAt > Date.now());
    // Retourner vers la route originale (ex. /status ou /authorize)
    const url = new URL(req.originalUrl, "http://localhost");
    const returnPath = url.pathname !== "/" ? url.pathname : undefined;

    if (cookieToken && sessionExpiresAt && !hasValidSession) {
      sessions.delete(cookieToken); // expirée -> nettoyage
      persistSessions(sessions);
    }

    if (req.method === "GET") {
      if (hasValidSession) return next();
      return res.status(200).type("html").send(renderPage({ fields: req.query, showPassphrase: true, returnPath }));
    }

    if (req.method === "POST") {
      if (hasValidSession) {
        process.stderr.write(`[authGate] Autorisation confirmée (session existante) — client_id=${req.body.client_id}\n`);
        return next();
      }

      const ip = req.ip;
      if (isLocked(ip)) {
        return res.status(429).type("html").send(renderPage({
          fields: req.body, showPassphrase: true, returnPath,
          error: "Trop de tentatives — réessaie dans quelques minutes.",
        }));
      }

      const supplied = typeof req.body.passphrase === "string" ? req.body.passphrase : "";
      const suppliedHash = crypto.createHash("sha256").update(supplied).digest();
      const match = crypto.timingSafeEqual(suppliedHash, expectedHash);

      if (!match) {
        recordFailure(ip);
        return res.status(401).type("html").send(renderPage({
          fields: req.body, showPassphrase: true, returnPath, error: "Passphrase incorrecte.",
        }));
      }

      recordSuccess(ip);
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, Date.now() + COOKIE_MAX_AGE_S * 1000);
      persistSessions(sessions);
      const isLocalhost = req.hostname === "localhost" || req.hostname === "127.0.0.1";
      const secure = isLocalhost ? "" : "; Secure";
      res.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; HttpOnly${secure}; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}; Path=/`);
      process.stderr.write(`[authGate] Passphrase validée, nouvelle session — client_id=${req.body.client_id}\n`);
      return next();
    }

    return res.status(405).send("Method Not Allowed");
  });

  return router;
}

module.exports = { authGate };
