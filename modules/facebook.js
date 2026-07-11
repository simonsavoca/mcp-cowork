const { z } = require('zod');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { renderResultPage } = require('./oauthRedirect');

const FB_API_VERSION = process.env.FACEBOOK_API_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${FB_API_VERSION}`;
const DIALOG = `https://www.facebook.com/${FB_API_VERSION}/dialog/oauth`;

// Scopes utilisables en mode Développement pour son propre compte/Pages (admin de l'app),
// sans App Review. La publication sur profil perso est impossible côté Meta depuis 2018 :
// le compte perso est en lecture seule, toute l'écriture passe par les Pages.
const FB_SCOPES = [
  'public_profile',
  'email',
  'user_posts',
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_posts',
  'pages_manage_engagement',
  'read_insights',
];

const TOKEN_STORE_PATH = path.join(__dirname, '..', 'data', 'facebook_token.json');

let _pendingState = null;

function redirectUri() {
  return new URL('/redirect/facebook', process.env.MCP_PUBLIC_URL).toString();
}

// Le user token longue durée (~60j) et les Page tokens (non-expirants) sont persistés
// dans data/facebook_token.json (gitignoré comme google_token.json). FACEBOOK_USER_TOKEN
// sert uniquement de bootstrap initial si le fichier n'existe pas encore.
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8'));
  } catch {
    return { user_token: process.env.FACEBOOK_USER_TOKEN || null, user_token_expiry: 0, pages: [] };
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(TOKEN_STORE_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(store, null, 2));
}

function getUserToken() {
  const store = loadStore();
  const token = store.user_token || process.env.FACEBOOK_USER_TOKEN;
  if (!token) {
    throw new Error('Aucun token Facebook — lance facebook_auth_url');
  }
  return token;
}

async function fbapi(pathOrUrl, { token, method = 'GET', params = {} } = {}) {
  if (!token) throw new Error('Token manquant — lance facebook_auth_url');

  const base = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${GRAPH}${pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl}`;
  const url = new URL(base);

  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }

  let res;
  if (method === 'GET') {
    for (const [k, v] of form) url.searchParams.set(k, v);
    url.searchParams.set('access_token', token);
    res = await fetch(url, { method: 'GET' });
  } else {
    url.searchParams.set('access_token', token);
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: method === 'DELETE' ? undefined : form,
    });
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`Facebook API ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// Résout un id/nom de Page vers son Page token. Rafraîchit depuis /me/accounts si absent.
async function resolvePageToken(idOrName) {
  const store = loadStore();
  let pages = store.pages || [];
  const match = (p) => p.id === idOrName || (p.name && p.name.toLowerCase() === String(idOrName).toLowerCase());
  let page = pages.find(match);

  if (!page || !page.access_token) {
    const userToken = store.user_token || process.env.FACEBOOK_USER_TOKEN;
    if (!userToken) throw new Error('Aucun token utilisateur — lance facebook_auth_url');
    const data = await fbapi('/me/accounts', {
      token: userToken,
      params: { fields: 'id,name,access_token,tasks', limit: 100 },
    });
    pages = (data.data || []).map((p) => ({ id: p.id, name: p.name, access_token: p.access_token, tasks: p.tasks }));
    store.pages = pages;
    saveStore(store);
    page = pages.find(match);
  }

  if (!page) throw new Error(`Page introuvable: "${idOrName}". Utilise facebook_pages pour lister les Pages.`);
  if (!page.access_token) throw new Error(`Aucun Page token pour "${idOrName}" (droits insuffisants sur la Page ?).`);
  return { pageId: page.id, token: page.access_token };
}

function ok(obj) {
  const structured = obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? obj : { items: obj };
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    structuredContent: structured,
  };
}

// Échange le code d'autorisation contre un token court terme, puis contre un token longue
// durée (~60j, fb_exchange_token) et récupère les Page tokens. Persisté dans
// data/facebook_token.json. Utilisé par le handler de redirection automatique
// (handleFacebookRedirect).
async function exchangeCodeForLongLivedToken(code) {
  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (!appId || !appSecret) throw new Error('FACEBOOK_APP_ID ou FACEBOOK_APP_SECRET manquante');

  // fbapi() exige un token existant (access_token en query) ; ici on échange le code contre
  // le tout premier token utilisateur, donc appel direct sans passer par fbapi().
  const exchangeUrl = new URL(`${GRAPH}/oauth/access_token`);
  exchangeUrl.searchParams.set('client_id', appId);
  exchangeUrl.searchParams.set('client_secret', appSecret);
  exchangeUrl.searchParams.set('redirect_uri', redirectUri());
  exchangeUrl.searchParams.set('code', code);
  const exchangeRes = await fetch(exchangeUrl);
  const exchangeText = await exchangeRes.text();
  if (!exchangeRes.ok) throw new Error(`Facebook API ${exchangeRes.status}: ${exchangeText}`);
  const shortLived = JSON.parse(exchangeText);

  const shortToken = shortLived.access_token;
  if (!shortToken) throw new Error(`Échange code->token échoué: ${JSON.stringify(shortLived)}`);

  const exch = await fbapi('/oauth/access_token', {
    token: shortToken,
    params: {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken,
    },
  });

  const longToken = exch.access_token;
  if (!longToken) throw new Error(`Échange long terme échoué: ${JSON.stringify(exch)}`);

  const expiresIn = Number(exch.expires_in) || 60 * 24 * 3600; // ~60j si non fourni
  const store = { user_token: longToken, user_token_expiry: Date.now() + expiresIn * 1000, pages: [] };

  const accounts = await fbapi('/me/accounts', {
    token: longToken,
    params: { fields: 'id,name,access_token,tasks', limit: 100 },
  });
  store.pages = (accounts.data || []).map((p) => ({
    id: p.id,
    name: p.name,
    access_token: p.access_token,
    tasks: p.tasks,
  }));
  saveStore(store);

  const me = await fbapi('/me', { token: longToken, params: { fields: 'id,name' } });
  return { me, store };
}

function registerFacebookTools(server) {
  // --- Auth ---

  server.tool(
    'facebook_auth',
    'Vérifie la configuration Facebook/Meta et valide le token stocké (profil + Pages)',
    {},
    async () => {
      const missing = ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'].filter((k) => !process.env[k]);
      if (missing.length) return ok({ error: `Variables manquantes: ${missing.join(', ')}` });

      const store = loadStore();
      const token = store.user_token || process.env.FACEBOOK_USER_TOKEN;
      if (!token) return ok({ error: 'Aucun token — lance facebook_auth_url' });

      try {
        const me = await fbapi('/me', { token, params: { fields: 'id,name' } });
        const expiry = store.user_token_expiry
          ? new Date(store.user_token_expiry).toISOString()
          : 'inconnue (token fourni via FACEBOOK_USER_TOKEN)';
        return ok({
          status: 'Auth OK',
          user: me,
          user_token_expiry: expiry,
          pages: (store.pages || []).map((p) => ({ id: p.id, name: p.name })),
        });
      } catch (e) {
        return ok({ error: `Auth KO — ${e.message}` });
      }
    }
  );

  server.tool(
    'facebook_auth_url',
    "Génère l'URL d'autorisation Facebook — l'authentification se termine automatiquement côté serveur (redirection), pas besoin de revenir dans le chat",
    {},
    async () => {
      const appId = process.env.FACEBOOK_APP_ID;
      if (!appId) return ok({ error: 'FACEBOOK_APP_ID manquante' });
      if (!process.env.MCP_PUBLIC_URL) return ok({ error: 'MCP_PUBLIC_URL manquante' });

      const state = crypto.randomBytes(16).toString('hex');
      _pendingState = state;

      const params = new URLSearchParams({
        client_id: appId,
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: FB_SCOPES.join(','),
        state,
      });

      return ok({
        url: `${DIALOG}?${params.toString()}`,
        message:
          "Ouvre cette URL, connecte-toi et autorise l'app. L'authentification se termine automatiquement (redirection serveur vers MCP_PUBLIC_URL/redirect/facebook) — inutile de copier un token. Vérifie ensuite avec facebook_auth. " +
          'Prérequis côté Meta for Developers (produit "Facebook Login", mode développement, self-serve, sans App Review) : déclarer ' +
          redirectUri() +
          ' dans "Valid OAuth Redirect URIs".',
      });
    }
  );

  // --- Compte personnel (lecture seule — Meta interdit la publication sur profil perso) ---

  server.tool(
    'facebook_profile',
    'Récupère le profil du compte personnel Facebook (lecture seule)',
    {},
    async () => {
      const token = getUserToken();
      const me = await fbapi('/me', {
        token,
        params: { fields: 'id,name,email,picture,link,birthday,location' },
      });
      return ok(me);
    }
  );

  server.tool(
    'facebook_posts',
    'Liste les publications du compte personnel (nécessite user_posts ; API Meta très limitée pour les profils perso)',
    {
      limit: z.number().int().min(1).max(100).optional().default(25).describe('Nombre de posts (défaut: 25)'),
    },
    async ({ limit = 25 } = {}) => {
      const token = getUserToken();
      const data = await fbapi('/me/posts', {
        token,
        params: { fields: 'id,message,story,created_time,permalink_url', limit },
      });
      return ok(data.data || []);
    }
  );

  server.tool(
    'facebook_pages',
    'Liste les Pages Facebook administrées par le compte (id, nom, catégorie, rôles) — pont vers la gestion des Pages',
    {},
    async () => {
      const token = getUserToken();
      const data = await fbapi('/me/accounts', {
        token,
        params: { fields: 'id,name,category,tasks', limit: 100 },
      });
      return ok((data.data || []).map((p) => ({ id: p.id, name: p.name, category: p.category, tasks: p.tasks })));
    }
  );

  // --- Gestion des Pages (lecture + écriture) ---

  server.tool(
    'facebook_page_feed',
    'Lit le fil (publications) d\'une Page',
    {
      page: z.string().describe('ID ou nom de la Page'),
      limit: z.number().int().min(1).max(100).optional().default(25).describe('Nombre de posts (défaut: 25)'),
    },
    async ({ page, limit = 25 }) => {
      const { pageId, token } = await resolvePageToken(page);
      const data = await fbapi(`/${pageId}/feed`, {
        token,
        params: { fields: 'id,message,story,created_time,permalink_url', limit },
      });
      return ok(data.data || []);
    }
  );

  server.tool(
    'facebook_page_post',
    'Publie (ou programme) un post texte/lien sur une Page. ⚠️ Écriture publique.',
    {
      page: z.string().describe('ID ou nom de la Page'),
      message: z.string().describe('Texte du post'),
      link: z.string().url().optional().describe('URL à joindre au post'),
      scheduled_publish_time: z
        .string()
        .optional()
        .describe('Programmation : timestamp Unix (secondes) ou date ISO. Doit être >10 min et <75 jours dans le futur.'),
    },
    async ({ page, message, link, scheduled_publish_time }) => {
      const { pageId, token } = await resolvePageToken(page);
      const params = { message };
      if (link) params.link = link;
      if (scheduled_publish_time) {
        const ts = /^\d+$/.test(scheduled_publish_time)
          ? Number(scheduled_publish_time)
          : Math.floor(new Date(scheduled_publish_time).getTime() / 1000);
        params.scheduled_publish_time = ts;
        params.published = false;
      }
      const res = await fbapi(`/${pageId}/feed`, { token, method: 'POST', params });
      return ok(res);
    }
  );

  server.tool(
    'facebook_page_photo',
    'Publie une photo (depuis une URL publique) sur une Page. ⚠️ Écriture publique.',
    {
      page: z.string().describe('ID ou nom de la Page'),
      url: z.string().url().describe("URL publique de l'image"),
      caption: z.string().optional().describe('Légende de la photo'),
    },
    async ({ page, url, caption }) => {
      const { pageId, token } = await resolvePageToken(page);
      const params = { url };
      if (caption) params.caption = caption;
      const res = await fbapi(`/${pageId}/photos`, { token, method: 'POST', params });
      return ok(res);
    }
  );

  server.tool(
    'facebook_page_post_update',
    'Modifie le message d\'un post de Page',
    {
      page: z.string().describe('ID ou nom de la Page propriétaire du post'),
      post_id: z.string().describe('ID du post à modifier'),
      message: z.string().describe('Nouveau texte'),
    },
    async ({ page, post_id, message }) => {
      const { token } = await resolvePageToken(page);
      const res = await fbapi(`/${post_id}`, { token, method: 'POST', params: { message } });
      return ok(res);
    }
  );

  server.tool(
    'facebook_page_post_delete',
    'Supprime un post de Page. ⚠️ IRRÉVERSIBLE.',
    {
      page: z.string().describe('ID ou nom de la Page propriétaire du post'),
      post_id: z.string().describe('ID du post à supprimer'),
    },
    async ({ page, post_id }) => {
      const { token } = await resolvePageToken(page);
      const res = await fbapi(`/${post_id}`, { token, method: 'DELETE' });
      return ok(res ?? { success: true, deleted: post_id });
    }
  );

  server.tool(
    'facebook_page_comments',
    'Lit les commentaires d\'un post (ou objet) de Page',
    {
      page: z.string().describe('ID ou nom de la Page'),
      object_id: z.string().describe('ID du post ou objet dont on lit les commentaires'),
      limit: z.number().int().min(1).max(100).optional().default(25).describe('Nombre de commentaires (défaut: 25)'),
    },
    async ({ page, object_id, limit = 25 }) => {
      const { token } = await resolvePageToken(page);
      const data = await fbapi(`/${object_id}/comments`, {
        token,
        params: { fields: 'id,from,message,created_time,like_count', limit },
      });
      return ok(data.data || []);
    }
  );

  server.tool(
    'facebook_page_comment_reply',
    'Commente/répond sur un post ou un commentaire de Page. ⚠️ Écriture publique.',
    {
      page: z.string().describe('ID ou nom de la Page'),
      object_id: z.string().describe('ID du post ou commentaire sur lequel commenter'),
      message: z.string().describe('Texte du commentaire'),
    },
    async ({ page, object_id, message }) => {
      const { token } = await resolvePageToken(page);
      const res = await fbapi(`/${object_id}/comments`, { token, method: 'POST', params: { message } });
      return ok(res);
    }
  );

  server.tool(
    'facebook_page_insights',
    'Récupère des statistiques (insights) d\'une Page',
    {
      page: z.string().describe('ID ou nom de la Page'),
      metric: z
        .string()
        .optional()
        .default('page_impressions,page_post_engagements,page_fans')
        .describe('Métriques séparées par des virgules'),
      period: z.enum(['day', 'week', 'days_28']).optional().default('day').describe('Période (défaut: day)'),
    },
    async ({ page, metric = 'page_impressions,page_post_engagements,page_fans', period = 'day' }) => {
      const { pageId, token } = await resolvePageToken(page);
      const data = await fbapi(`/${pageId}/insights`, { token, params: { metric, period } });
      return ok(data.data || []);
    }
  );
}

async function handleFacebookRedirect(req, res) {
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
        message: "Le paramètre state ne correspond pas à une demande d'autorisation en cours. Relance facebook_auth_url et réessaie.",
      })
    );
    return;
  }

  try {
    await exchangeCodeForLongLivedToken(code);
    _pendingState = null;
    res.status(200).type('html').send(
      renderResultPage({
        success: true,
        title: '✅ Authentification Facebook réussie',
        message: 'Tu peux fermer cet onglet et revenir au chat. Vérifie avec facebook_auth.',
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

module.exports = { registerFacebookTools, handleFacebookRedirect };
