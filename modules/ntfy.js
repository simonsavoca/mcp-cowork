const { z } = require('zod');

const PRIORITY_NAMES = ['min', 'low', 'default', 'high', 'max'];
const PRIORITY_BY_NAME = { min: 1, low: 2, default: 3, high: 4, max: 5 };

function serverUrl() {
  return (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
}

function resolveTopic(topic) {
  const t = topic || process.env.NTFY_TOPIC;
  if (!t) throw new Error('Topic manquant : passez topic ou définissez NTFY_TOPIC');
  return t;
}

function authHeaders() {
  if (process.env.NTFY_TOKEN) return { Authorization: `Bearer ${process.env.NTFY_TOKEN}` };
  if (process.env.NTFY_USERNAME && process.env.NTFY_PASSWORD) {
    const creds = Buffer.from(`${process.env.NTFY_USERNAME}:${process.env.NTFY_PASSWORD}`).toString('base64');
    return { Authorization: `Basic ${creds}` };
  }
  return {};
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

function registerNtfyTools(server) {
  server.tool(
    'ntfy_auth',
    'Vérifier qu\'un topic ntfy est joignable (serveur, topic, authentification)',
    { topic: z.string().optional().describe('Topic à tester (défaut : NTFY_TOPIC)') },
    async ({ topic }) => {
      let t;
      try {
        t = resolveTopic(topic);
      } catch (e) {
        return ok(e.message);
      }
      try {
        const res = await fetch(`${serverUrl()}/${encodeURIComponent(t)}/json?poll=1&since=1s`, {
          headers: authHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        return ok(`Auth OK — serveur ${serverUrl()} joignable, topic "${t}" accessible.`);
      } catch (e) {
        return ok(`Auth KO — ${e.message}`);
      }
    }
  );

  server.tool(
    'ntfy_send',
    'Publie une notification sur un topic ntfy (ntfy.sh ou serveur auto-hébergé)',
    {
      message: z.string().describe('Corps du message'),
      topic: z.string().optional().describe('Topic cible (défaut : NTFY_TOPIC)'),
      title: z.string().optional().describe('Titre de la notification'),
      priority: z.enum(['1', '2', '3', '4', '5', ...PRIORITY_NAMES]).optional().describe(
        'Priorité : 1/min (silencieuse) à 5/max (urgente), défaut 3/default'
      ),
      tags: z.array(z.string()).optional().describe('Tags/emojis ntfy (ex: ["warning", "skull"])'),
      click: z.string().optional().describe('URL ouverte au tap sur la notification'),
      attach: z.string().optional().describe('URL d\'un fichier à joindre'),
      filename: z.string().optional().describe('Nom de fichier affiché pour la pièce jointe'),
      icon: z.string().optional().describe('URL d\'une icône JPEG/PNG personnalisée'),
      markdown: z.boolean().optional().describe('Active le rendu Markdown dans le corps du message'),
      email: z.string().optional().describe('Adresse email à laquelle transférer la notification'),
      delay: z.string().optional().describe('Délai de livraison (ex: "30m", "tomorrow, 10am"), entre 10s et 3 jours'),
      actions: z
        .array(
          z.object({
            action: z.enum(['view', 'http', 'broadcast', 'copy']),
            label: z.string(),
            url: z.string().optional(),
            method: z.string().optional(),
            headers: z.record(z.string(), z.string()).optional(),
            body: z.string().optional(),
            intent: z.string().optional(),
            extras: z.record(z.string(), z.string()).optional(),
            value: z.string().optional(),
            clear: z.boolean().optional(),
          })
        )
        .max(3)
        .optional()
        .describe('Jusqu\'à 3 boutons d\'action interactifs'),
    },
    async ({ message, topic, title, priority, tags, click, attach, filename, icon, markdown, email, delay, actions }) => {
      const payload = { topic: resolveTopic(topic), message };
      if (title) payload.title = title;
      if (priority) payload.priority = PRIORITY_NAMES.includes(priority) ? PRIORITY_BY_NAME[priority] : parseInt(priority, 10);
      if (tags && tags.length) payload.tags = tags;
      if (click) payload.click = click;
      if (attach) payload.attach = attach;
      if (filename) payload.filename = filename;
      if (icon) payload.icon = icon;
      if (markdown) payload.markdown = true;
      if (email) payload.email = email;
      if (delay) payload.delay = delay;
      if (actions && actions.length) payload.actions = actions;

      const res = await fetch(`${serverUrl()}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`ntfy ${res.status}: ${data.error || JSON.stringify(data)}`);
      return ok({ id: data.id, time: data.time, topic: data.topic });
    }
  );

  server.tool(
    'ntfy_poll',
    'Récupère les messages en cache d\'un topic ntfy (requête ponctuelle, sans connexion persistante)',
    {
      topic: z.string().optional().describe('Topic à interroger (défaut : NTFY_TOPIC)'),
      since: z
        .string()
        .optional()
        .describe('Depuis quand : durée ("10m"), timestamp Unix, ID de message, "all" ou "latest" (défaut : "all")'),
    },
    async ({ topic, since }) => {
      const qs = new URLSearchParams({ poll: '1', since: since || 'all' });
      const res = await fetch(`${serverUrl()}/${encodeURIComponent(resolveTopic(topic))}/json?${qs}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text()}`);
      const text = (await res.text()).trim();
      const messages = text.length ? text.split('\n').map((line) => JSON.parse(line)) : [];
      return ok(messages);
    }
  );
}

module.exports = { registerNtfyTools };
