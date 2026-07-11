const { z } = require('zod');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const LINKEDIN_API_VERSION = process.env.LINKEDIN_API_VERSION || '202505';
const AUTHORIZE_ENDPOINT = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_ENDPOINT = 'https://www.linkedin.com/oauth/v2/accessToken';
const USERINFO_ENDPOINT = 'https://api.linkedin.com/v2/userinfo';
const REST_API = 'https://api.linkedin.com/rest';

// Scopes self-serve (produits "Sign In with LinkedIn using OpenID Connect" + "Share on
// LinkedIn", activables sans App Review dans le Developer Portal). Pas d'accès Pages
// entreprise (w_organization_social) ni messagerie (w_messages, réservé aux partenaires
// Recruiter/Sales Navigator) — hors périmètre pour un usage perso self-serve.
const LINKEDIN_SCOPES = ['openid', 'profile', 'email', 'w_member_social'];

const TOKEN_STORE_PATH = path.join(__dirname, '..', 'data', 'linkedin_token.json');

function redirectUri() {
  return new URL('/redirect/linkedin', process.env.MCP_PUBLIC_URL).toString();
}

// Token longue durée (~60j, pas de refresh token pour ce type d'app) persisté dans
// data/linkedin_token.json (gitignoré comme facebook_token.json/google_token.json).
// LINKEDIN_ACCESS_TOKEN sert uniquement de bootstrap initial si le fichier n'existe pas.
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8'));
  } catch {
    return { access_token: process.env.LINKEDIN_ACCESS_TOKEN || null, expiry: 0, sub: null };
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(TOKEN_STORE_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(store, null, 2));
}

function getAccessToken() {
  const store = loadStore();
  const token = store.access_token || process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token) {
    throw new Error('Aucun token LinkedIn — lance linkedin_auth_url');
  }
  return token;
}

async function linkedinApi(pathOrUrl, { token, method = 'GET', body } = {}) {
  if (!token) throw new Error('Token manquant — lance linkedin_auth_url');

  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${REST_API}${pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl}`;

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Restli-Protocol-Version': '2.0.0',
    'LinkedIn-Version': LINKEDIN_API_VERSION,
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`LinkedIn API ${res.status}: ${text}`);
  return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
}

async function fetchUserinfo(token) {
  const res = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`LinkedIn API ${res.status}: ${text}`);
  return JSON.parse(text);
}

// Résout l'URN auteur nécessaire à l'API Posts. Mémorisé dans le store après le premier appel.
async function resolveAuthorUrn() {
  const store = loadStore();
  let sub = store.sub;
  const token = store.access_token || process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token) throw new Error('Aucun token LinkedIn — lance linkedin_auth_url');

  if (!sub) {
    const info = await fetchUserinfo(token);
    sub = info.sub;
    store.sub = sub;
    saveStore(store);
  }

  return `urn:li:person:${sub}`;
}

async function exchangeCodeForToken(code) {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(),
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error(`Échange échoué: ${JSON.stringify(data)}`);

  const expiresIn = Number(data.expires_in) || 60 * 24 * 3600; // ~60j si non fourni
  const store = { access_token: data.access_token, expiry: Date.now() + expiresIn * 1000, sub: null };

  const info = await fetchUserinfo(store.access_token);
  store.sub = info.sub;
  saveStore(store);

  return { store, profile: info };
}

function ok(obj) {
  const structured = obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? obj : { items: obj };
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    structuredContent: structured,
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderResultPage({ success, title, message }) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f1115;
      color: #e5e7eb;
      padding: 20px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #171a21;
      border: 1px solid #262b35;
      border-radius: 8px;
      padding: 32px;
      max-width: 480px;
      text-align: center;
    }
    h1 { font-size: 20px; margin-bottom: 12px; color: ${success ? '#25d366' : '#ef5350'}; }
    p { color: #8b93a3; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

let _pendingState = null;

function registerLinkedinTools(server) {
  server.tool(
    'linkedin_auth',
    'Vérifie la configuration LinkedIn et valide le token stocké (profil)',
    {},
    async () => {
      const missing = ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'].filter((k) => !process.env[k]);
      if (!process.env.MCP_PUBLIC_URL) missing.push('MCP_PUBLIC_URL');
      if (missing.length) return ok({ error: `Variables manquantes: ${missing.join(', ')}` });

      const store = loadStore();
      const token = store.access_token || process.env.LINKEDIN_ACCESS_TOKEN;
      if (!token) return ok({ error: 'Aucun token — lance linkedin_auth_url' });

      try {
        const info = await fetchUserinfo(token);
        const expiry = store.expiry ? new Date(store.expiry).toISOString() : 'inconnue (token fourni via LINKEDIN_ACCESS_TOKEN)';
        return ok({ status: 'Auth OK', user: { sub: info.sub, name: info.name, email: info.email }, token_expiry: expiry });
      } catch (e) {
        return ok({ error: `Auth KO — ${e.message}` });
      }
    }
  );

  server.tool(
    'linkedin_auth_url',
    "Génère l'URL d'autorisation LinkedIn — l'authentification se termine automatiquement côté serveur (redirection), pas besoin de revenir dans le chat",
    {},
    async () => {
      const clientId = process.env.LINKEDIN_CLIENT_ID;
      if (!clientId) return ok({ error: 'LINKEDIN_CLIENT_ID manquante' });
      if (!process.env.MCP_PUBLIC_URL) return ok({ error: 'MCP_PUBLIC_URL manquante' });

      const state = crypto.randomBytes(16).toString('hex');
      _pendingState = state;

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri(),
        scope: LINKEDIN_SCOPES.join(' '),
        state,
      });

      return ok({
        url: `${AUTHORIZE_ENDPOINT}?${params.toString()}`,
        message:
          "Ouvre cette URL, connecte-toi et autorise l'app. L'authentification se termine automatiquement (redirection serveur vers MCP_PUBLIC_URL/redirect/linkedin) — inutile de copier un code. Vérifie ensuite avec linkedin_auth. " +
          'Prérequis côté LinkedIn Developer Portal (section Products, self-serve, sans App Review) : activer "Sign In with LinkedIn using OpenID Connect" et "Share on LinkedIn", et déclarer ' +
          redirectUri() +
          " comme redirect URI autorisée de l'app.",
      });
    }
  );

  server.tool(
    'linkedin_profile',
    'Récupère le profil LinkedIn du compte authentifié (OpenID Connect userinfo)',
    {},
    async () => {
      const token = getAccessToken();
      const info = await fetchUserinfo(token);
      return ok(info);
    }
  );

  server.tool(
    'linkedin_post_create',
    'Publie un post texte (avec lien optionnel) sur le profil personnel LinkedIn. ⚠️ Écriture publique.',
    {
      text: z.string().describe('Texte du post'),
      link: z.string().url().optional().describe('URL à joindre au post (article/lien)'),
    },
    async ({ text, link }) => {
      const token = getAccessToken();
      const author = await resolveAuthorUrn();

      const body = {
        author,
        commentary: text,
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
      };
      if (link) body.content = { article: { source: link } };

      const res = await linkedinApi('/posts', { token, method: 'POST', body });
      const postId = res.headers.get('x-restli-id') || res.data?.id || null;
      return ok({ id: postId, status: res.status });
    }
  );
}

async function handleLinkedinRedirect(req, res) {
  const { code, state, error, error_description } = req.query;

  if (error) {
    res.status(400).type('html').send(
      renderResultPage({
        success: false,
        title: '❌ Autorisation refusée',
        message: error_description || String(error),
      })
    );
    return;
  }

  if (!state || state !== _pendingState) {
    res.status(400).type('html').send(
      renderResultPage({
        success: false,
        title: '❌ State invalide',
        message: "Le paramètre state ne correspond pas à une demande d'autorisation en cours. Relance linkedin_auth_url et réessaie.",
      })
    );
    return;
  }

  try {
    await exchangeCodeForToken(code);
    _pendingState = null;
    res.status(200).type('html').send(
      renderResultPage({
        success: true,
        title: '✅ Authentification LinkedIn réussie',
        message: 'Tu peux fermer cet onglet et revenir au chat. Vérifie avec linkedin_auth.',
      })
    );
  } catch (e) {
    res.status(500).type('html').send(
      renderResultPage({
        success: false,
        title: "❌ Échec de l'authentification",
        message: e.message,
      })
    );
  }
}

module.exports = { registerLinkedinTools, handleLinkedinRedirect };
