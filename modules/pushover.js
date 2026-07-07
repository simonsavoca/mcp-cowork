const { z } = require('zod');

const BASE = 'https://api.pushover.net/1';

function appToken() {
  const token = process.env.PUSHOVER_APP_TOKEN;
  if (!token) throw new Error('PUSHOVER_APP_TOKEN manquant');
  return token;
}

function userKey() {
  const key = process.env.PUSHOVER_USER_KEY;
  if (!key) throw new Error('PUSHOVER_USER_KEY manquant');
  return key;
}

function ok(data) {
  if (typeof data === 'string') {
    return { content: [{ type: 'text', text: data }], structuredContent: { message: data } };
  }
  const structured = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : { items: data };
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: structured,
  };
}

function registerPushoverTools(server) {
  server.tool('pushover_auth', 'Vérifier que le token d\'application Pushover est valide', {}, async () => {
    if (!process.env.PUSHOVER_APP_TOKEN || !process.env.PUSHOVER_USER_KEY) {
      const missing = ['PUSHOVER_APP_TOKEN', 'PUSHOVER_USER_KEY'].filter(k => !process.env[k]);
      return ok(`Variables d'env manquantes : ${missing.join(', ')}`);
    }
    try {
      const qs = new URLSearchParams({ token: appToken() }).toString();
      const res = await fetch(`${BASE}/apps/limits.json?${qs}`);
      const data = await res.json();
      if (!res.ok || data.status !== 1) {
        throw new Error(data.errors?.join(', ') || `HTTP ${res.status}`);
      }
      return ok(`Auth OK (token) — quota restant : ${data.remaining}/${data.limit}. Note : la validité de PUSHOVER_USER_KEY n'est vérifiée qu'à l'envoi.`);
    } catch (e) {
      return ok(`Auth KO — ${e.message}`);
    }
  });

  server.tool(
    'pushover_send',
    'Envoie une notification push via Pushover.net vers le destinataire configuré (PUSHOVER_USER_KEY)',
    {
      message: z.string().describe('Corps du message (max 1024 caractères)'),
      title: z.string().optional().describe('Titre de la notification (max 250 caractères, défaut : nom de l\'app)'),
      priority: z.enum(['-2', '-1', '0', '1']).optional().describe(
        'Priorité : -2 silencieuse (badge uniquement), -1 basse (pas de son/vibration), 0 normale (défaut), 1 haute (ignore les heures calmes)'
      ),
      sound: z.string().optional().describe('Nom du son de notification (ex: "bike", "siren", "none")'),
      url: z.string().optional().describe('URL supplémentaire jointe à la notification (max 512 caractères)'),
      url_title: z.string().optional().describe('Titre affiché pour l\'URL jointe (max 100 caractères)'),
      device: z.string().optional().describe('Cibler un device Pushover précis (défaut : tous les devices actifs)'),
      html: z.boolean().optional().describe('Activer le formatage HTML dans le corps du message'),
    },
    async ({ message, title, priority, sound, url, url_title, device, html }) => {
      const params = new URLSearchParams({ token: appToken(), user: userKey(), message });
      if (title) params.set('title', title);
      if (priority) params.set('priority', priority);
      if (sound) params.set('sound', sound);
      if (url) params.set('url', url);
      if (url_title) params.set('url_title', url_title);
      if (device) params.set('device', device);
      if (html) params.set('html', '1');

      const res = await fetch(`${BASE}/messages.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
      const data = await res.json();
      if (!res.ok || data.status !== 1) {
        throw new Error(`Pushover ${res.status}: ${data.errors?.join(', ') || 'erreur inconnue'}`);
      }
      return ok({ request: data.request });
    }
  );
}

module.exports = { registerPushoverTools };
