const { z } = require('zod');
const path = require('path');
const fs = require('fs');

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
    throw new Error('Aucun token Facebook — lance facebook_auth_url puis facebook_auth_callback');
  }
  return token;
}

async function fbapi(pathOrUrl, { token, method = 'GET', params = {} } = {}) {
  if (!token) throw new Error('Token manquant — bootstrap via facebook_auth_callback');

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
    if (!userToken) throw new Error('Aucun token utilisateur — bootstrap via facebook_auth_callback');
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
      if (!token) return ok({ error: 'Aucun token — lance facebook_auth_url puis facebook_auth_callback' });

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
    'Instructions + URL pour obtenir un token Facebook (via Graph API Explorer, méthode recommandée)',
    {},
    async () => {
      const appId = process.env.FACEBOOK_APP_ID;
      if (!appId) return ok({ error: 'FACEBOOK_APP_ID manquante' });

      const scopes = FB_SCOPES.join(',');
      const explorer = `https://developers.facebook.com/tools/explorer/?method=GET&path=me&version=${FB_API_VERSION}`;
      const dialog = `${DIALOG}?${new URLSearchParams({
        client_id: appId,
        redirect_uri: 'https://www.facebook.com/connect/login_success.html',
        response_type: 'token',
        scope: scopes,
      }).toString()}`;

      return ok({
        methode_recommandee: 'Graph API Explorer',
        explorer_url: explorer,
        scopes_a_cocher: scopes,
        dialog_url_alternative: dialog,
        message:
          'Recommandé : ouvre explorer_url, sélectionne ton app, coche les scopes ci-dessus, clique "Generate Access Token", autorise, puis copie le token et appelle facebook_auth_callback (paramètre token). ' +
          "Alternative : ouvre dialog_url_alternative, autorise, et récupère le access_token dans l'URL de redirection (après #access_token=).",
      });
    }
  );

  server.tool(
    'facebook_auth_callback',
    'Échange un token utilisateur Facebook en token longue durée (~60j) et récupère les Page tokens',
    {
      token: z.string().describe('User Access Token copié depuis le Graph API Explorer'),
    },
    async ({ token }) => {
      const appId = process.env.FACEBOOK_APP_ID;
      const appSecret = process.env.FACEBOOK_APP_SECRET;
      if (!appId || !appSecret) return ok({ error: 'FACEBOOK_APP_ID ou FACEBOOK_APP_SECRET manquante' });

      try {
        const exch = await fbapi('/oauth/access_token', {
          token,
          params: {
            grant_type: 'fb_exchange_token',
            client_id: appId,
            client_secret: appSecret,
            fb_exchange_token: token,
          },
        });

        const longToken = exch.access_token;
        if (!longToken) return ok({ error: `Échange échoué: ${JSON.stringify(exch)}` });

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
        return ok({
          status: 'Auth OK',
          user: me,
          user_token_expiry: new Date(store.user_token_expiry).toISOString(),
          pages: store.pages.map((p) => ({ id: p.id, name: p.name })),
          message: 'Token longue durée + Page tokens sauvegardés (data/facebook_token.json).',
        });
      } catch (e) {
        return ok({ error: `Callback échouée: ${e.message}` });
      }
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

module.exports = { registerFacebookTools };
