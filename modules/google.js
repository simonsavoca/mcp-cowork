const { z } = require('zod');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PEOPLE_API = 'https://people.googleapis.com/v1';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts',
].join(' ');

const TOKEN_STORE_PATH = path.join(__dirname, '..', 'data', 'google_token.json');

let _token = null, _tokenExpiry = 0, _refreshPromise = null;
let _pkceVerifier = null;

// Sous Claude Desktop, user_config n'est pas réinscriptible par le serveur (pas d'équivalent .mcp.json).
// Le refresh token rafraîchi est donc mis en cache dans data/google_token.json, propre à ce bundle,
// et prend le pas sur GOOGLE_REFRESH_TOKEN (fourni par user_config) s'il existe déjà.
function loadStoredRefreshToken() {
  try {
    const raw = fs.readFileSync(TOKEN_STORE_PATH, 'utf8');
    return JSON.parse(raw).refresh_token || null;
  } catch {
    return null;
  }
}

function storeRefreshToken(refreshToken) {
  fs.mkdirSync(path.dirname(TOKEN_STORE_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify({ refresh_token: refreshToken }, null, 2));
  process.env.GOOGLE_REFRESH_TOKEN = refreshToken;
}

async function getToken() {
  if (_token && Date.now() < _tokenExpiry - 60000) return _token;

  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = loadStoredRefreshToken() || process.env.GOOGLE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Variables manquantes: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
    }

    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    const data = await res.json();
    if (!data.access_token) throw new Error(`Google token KO: ${JSON.stringify(data)}`);

    _token = data.access_token;
    _tokenExpiry = Date.now() + (Math.max(Number(data.expires_in) || 3600, 60)) * 1000;
    return _token;
  })();

  try {
    return await _refreshPromise;
  } finally {
    _refreshPromise = null;
  }
}

async function gapi(url, options = {}) {
  const token = await getToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function ok(obj) {
  const structured = obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? obj : { items: obj };
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    structuredContent: structured,
  };
}

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { code_verifier: verifier, code_challenge: challenge };
}

function registerGoogleTools(server) {
  server.tool(
    'google_auth',
    'Vérifier que les credentials Google OAuth2 sont valides',
    {},
    async () => {
      const missing = [
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
      ].filter(k => !process.env[k]);
      if (!loadStoredRefreshToken() && !process.env.GOOGLE_REFRESH_TOKEN) missing.push('GOOGLE_REFRESH_TOKEN');

      if (missing.length) return ok({ error: `Variables manquantes: ${missing.join(', ')}` });

      try {
        const profile = await gapi(`${GMAIL_API}/users/me/profile`);
        return ok({ status: 'Auth OK', emailAddress: profile.emailAddress });
      } catch (e) {
        return ok({ error: `Auth KO — ${e.message}` });
      }
    }
  );

  server.tool(
    'google_auth_url',
    'Générer une URL OAuth2 pour obtenir le refresh token Google',
    {},
    async () => {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) return ok({ error: 'GOOGLE_CLIENT_ID manquante' });

      const challenge = generatePKCE();
      _pkceVerifier = challenge.code_verifier;

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: 'http://localhost',
        response_type: 'code',
        scope: GOOGLE_SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge.code_challenge,
        code_challenge_method: 'S256',
      });

      const authUrl = `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
      return ok({
        url: authUrl,
        message: 'Ouvre cette URL dans ton navigateur. Après acceptation, Google te redirigera vers http://localhost?code=XXX. Copie le code (la partie après "code=") et appelle google_auth_callback avec.',
      });
    }
  );

  server.tool(
    'google_auth_callback',
    'Échanger le code OAuth2 contre un refresh token',
    {
      code: z.string().describe('Code d\'authentification Google (depuis l\'URL de redirection)'),
    },
    async ({ code }) => {
      if (!_pkceVerifier) {
        return ok({ error: 'Appelle google_auth_url d\'abord pour initialiser PKCE' });
      }

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        return ok({ error: 'GOOGLE_CLIENT_ID ou GOOGLE_CLIENT_SECRET manquante' });
      }

      try {
        const res = await fetch(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: 'http://localhost',
            code_verifier: _pkceVerifier,
          }),
        });

        const data = await res.json();
        if (!data.refresh_token) {
          return ok({ error: `Token exchange échouée: ${JSON.stringify(data)}` });
        }

        storeRefreshToken(data.refresh_token);

        _token = null;
        _tokenExpiry = 0;
        _pkceVerifier = null;

        const profile = await gapi(`${GMAIL_API}/users/me/profile`);
        return ok({
          status: 'Auth OK',
          emailAddress: profile.emailAddress,
          message: 'Refresh token sauvegardé (data/google_token.json) et credentials valides!',
        });
      } catch (e) {
        _pkceVerifier = null;
        return ok({ error: `Callback échouée: ${e.message}` });
      }
    }
  );

  server.tool(
    'google_contacts',
    'Liste ou recherche les contacts Google (People API)',
    {
      search: z.string().optional().describe('Texte à rechercher dans les contacts'),
      limit: z.number().int().min(1).max(1000).optional().default(50).describe('Nombre de contacts (défaut: 50)'),
      page_token: z.string().optional().describe('Token de pagination pour continuer une recherche précédente'),
    },
    async ({ search, limit = 50, page_token } = {}) => {
      let contacts = [];
      let nextPageToken = page_token || undefined;
      let pageSize = Math.min(limit, 100);

      while (contacts.length < limit) {
        let url = `${PEOPLE_API}/people/me/connections?pageSize=${pageSize}&personFields=names,emailAddresses,phoneNumbers`;
        if (nextPageToken) url += `&pageToken=${nextPageToken}`;

        const data = await gapi(url);
        const newContacts = data.connections || [];

        if (newContacts.length === 0) break;

        contacts = contacts.concat(newContacts);
        nextPageToken = data.nextPageToken;

        if (!nextPageToken || contacts.length >= limit) break;
      }

      contacts = contacts.slice(0, limit);

      if (search) {
        const needle = search.toLowerCase();
        contacts = contacts.filter(c => {
          const names = (c.names || []).map(n => n?.displayName?.toLowerCase() || '');
          const emails = (c.emailAddresses || []).map(e => e?.value?.toLowerCase() || '');
          return names.some(n => n.includes(needle)) || emails.some(e => e.includes(needle));
        });
      }

      const formatted = contacts.map(c => ({
        displayName: c.names?.[0]?.displayName,
        emails: c.emailAddresses?.map(e => e.value) || [],
        phones: c.phoneNumbers?.map(p => p.value) || [],
      }));

      return ok({
        contacts: formatted,
        total: formatted.length,
        next_page_token: nextPageToken,
      });
    }
  );

  server.tool(
    'google_mail_profile',
    'Récupère le profil Gmail (compteurs)',
    {},
    async () => {
      const profile = await gapi(`${GMAIL_API}/users/me/profile`);
      return ok(profile);
    }
  );

  server.tool(
    'google_mail_list',
    'Recherche des messages Gmail',
    {
      q: z.string().optional().describe('Requête de recherche (ex: "newer_than:7d", "from:alice@example.com")'),
      limit: z.number().int().min(1).max(50).optional().default(20).describe('Nombre de messages'),
      format: z.enum(['minimal', 'full']).optional().default('minimal').describe('Format de réponse'),
    },
    async ({ q, limit = 20, format = 'minimal' } = {}) => {
      let url = `${GMAIL_API}/users/me/messages?maxResults=${limit}`;
      if (q) url += `&q=${encodeURIComponent(q)}`;

      const data = await gapi(url);
      const messages = data.messages || [];

      if (format === 'minimal') {
        return ok(messages);
      }

      const full = [];
      for (const msg of messages.slice(0, 5)) {
        try {
          const detail = await gapi(`${GMAIL_API}/users/me/messages/${msg.id}?format=full`);
          const headers = detail?.payload?.headers || [];
          full.push({
            id: msg.id,
            from: headers.find(h => h.name === 'From')?.value,
            subject: headers.find(h => h.name === 'Subject')?.value,
            date: headers.find(h => h.name === 'Date')?.value,
            snippet: detail.snippet,
          });
        } catch (err) {
          full.push({
            id: msg.id,
            error: err.message,
          });
        }
      }

      return ok(full);
    }
  );

  server.tool(
    'google_mail_get',
    'Récupère le contenu complet d\'un message Gmail',
    {
      id: z.string().describe('ID du message'),
    },
    async ({ id }) => {
      const msg = await gapi(`${GMAIL_API}/users/me/messages/${id}?format=full`);
      const headers = msg?.payload?.headers || [];

      const from = headers.find(h => h.name === 'From')?.value;
      const to = headers.find(h => h.name === 'To')?.value;
      const subject = headers.find(h => h.name === 'Subject')?.value;
      const date = headers.find(h => h.name === 'Date')?.value;

      let body = '';
      if (msg?.payload?.parts) {
        const textPart = msg.payload.parts.find(p => p.mimeType === 'text/plain');
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
        }
      } else if (msg?.payload?.body?.data) {
        body = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
      }

      return ok({ from, to, subject, date, snippet: msg.snippet, body });
    }
  );

  server.tool(
    'google_calendar_list',
    'Liste tous les calendriers accessibles',
    {},
    async () => {
      const data = await gapi(`${CALENDAR_API}/users/me/calendarList`);
      return ok(data.items || []);
    }
  );

  server.tool(
    'google_calendar_events',
    'Récupère les événements à venir',
    {
      calendar_id: z.string().optional().default('primary').describe('ID du calendrier (défaut: primary pour simon.savoca@gmail.com)'),
      days: z.number().int().min(1).max(90).optional().default(7).describe('Horizon en jours'),
    },
    async ({ calendar_id = 'primary', days = 7 } = {}) => {
      const now = new Date().toISOString();
      const later = new Date(Date.now() + days * 86400000).toISOString();

      const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendar_id)}/events?timeMin=${encodeURIComponent(now)}&timeMax=${encodeURIComponent(later)}&singleEvents=true&orderBy=startTime`;

      const data = await gapi(url);
      const events = (data.items || []).map(e => ({
        id: e.id,
        summary: e.summary,
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
        location: e.location,
        organizer: e.organizer?.email,
      }));

      return ok(events);
    }
  );
}

module.exports = { registerGoogleTools };
