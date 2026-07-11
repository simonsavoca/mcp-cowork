const { z } = require('zod');

const BASE = 'https://graph.microsoft.com/v1.0';

let _token = null, _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry - 60000) return _token;
  const tenantId = process.env.M365_TENANT_ID;
  if (!tenantId) throw new Error('M365_TENANT_ID manquant');
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.M365_CLIENT_ID,
        client_secret: process.env.M365_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
      }),
    }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token KO: ${JSON.stringify(data)}`);
  _token = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000;
  return _token;
}

async function graph(path, options = {}) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Noms canoniques acceptés directement par Graph API sans résolution.
const WELL_KNOWN_FOLDERS = new Set([
  'inbox', 'drafts', 'sentitems', 'deleteditems', 'junkemail',
  'outbox', 'archive', 'clutter', 'conflicts', 'conversationhistory',
  'localfailures', 'msgfolderroot', 'recoverableitemsdeletions',
  'scheduled', 'searchfolders', 'serverfailures', 'syncissues',
]);

// Résout un nom de dossier humain (ex: "Associations/Bodega") en ID Graph, ou null si introuvable.
// Si `nameOrId` ressemble déjà à un ID (long alphanumérique), le retourne tel quel.
// Les noms canoniques Graph (inbox, drafts…) sont retournés tels quels.
// Supporte les chemins avec "/" et la recherche récursive pour les noms simples.
async function findFolderId(nameOrId, user) {
  if (/^[A-Za-z0-9_+/=-]{50,}$/.test(nameOrId)) return nameOrId;
  if (WELL_KNOWN_FOLDERS.has(nameOrId.toLowerCase())) return nameOrId.toLowerCase();

  const parts = nameOrId.split('/').map(p => p.trim()).filter(Boolean);

  if (parts.length > 1) {
    let currentId = null;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const needle = part.toLowerCase();
      let matchId = null;

      if (currentId) {
        const url = `/users/${user}/mailFolders/${encodeURIComponent(currentId)}/childFolders?$top=200&$select=id,displayName`;
        const data = await graph(url);
        const folder = (data.value || []).find(f => f.displayName.toLowerCase() === needle);
        if (folder) matchId = folder.id;
      } else if (i === 0) {
        const topData = await graph(`/users/${user}/mailFolders?$top=200&$select=id,displayName`);
        const folder = (topData.value || []).find(f => f.displayName.toLowerCase() === needle);
        if (folder) {
          matchId = folder.id;
        } else {
          for (const folder of (topData.value || [])) {
            matchId = await findInChildFolders(folder.id, needle, user);
            if (matchId) break;
          }
        }
      }

      if (!matchId) return null;
      currentId = matchId;
    }
    return currentId;
  }

  const needle = nameOrId.toLowerCase();
  const topData = await graph(`/users/${user}/mailFolders?$top=200&$select=id,displayName`);
  const topMatch = (topData.value || []).find(f => f.displayName.toLowerCase() === needle);
  if (topMatch) return topMatch.id;

  for (const folder of (topData.value || [])) {
    const found = await findInChildFolders(folder.id, needle, user);
    if (found) return found;
  }

  return null;
}

// Rejette une valeur qui ressemble à un chemin humain (ex: "Boîte de réception/Achat").
// Les opérations sur les dossiers attendent un ID (ou un nom canonique Graph : inbox, archive…).
// Pour obtenir un ID à partir d'un nom/chemin, utiliser m365_mail_folder_exists.
function assertFolderId(value) {
  if (value.includes('/')) {
    throw new Error(
      `"${value}" ressemble à un chemin, pas à un ID de dossier. ` +
      `Récupère l'ID via m365_mail_folder_exists (ou m365_mail_folders), puis réessaie.`
    );
  }
}

// Crée un dossier nommé `name` sous `parentId` (racine si absent).
// Idempotent : si un dossier de même nom existe déjà sous ce parent, il est renvoyé tel quel.
// Renvoie { id, displayName, parentFolderId, created }.
async function createFolder(name, parentId, user) {
  const base = parentId
    ? `/users/${user}/mailFolders/${encodeURIComponent(parentId)}/childFolders`
    : `/users/${user}/mailFolders`;

  const data = await graph(`${base}?$top=200&$select=id,displayName,parentFolderId`);
  const needle = name.toLowerCase();
  const existing = (data.value || []).find(f => f.displayName.toLowerCase() === needle);

  const leaf = existing || await graph(base, {
    method: 'POST',
    body: JSON.stringify({ displayName: name }),
  });

  return {
    id: leaf.id,
    displayName: leaf.displayName,
    parentFolderId: leaf.parentFolderId,
    created: !existing,
  };
}

function assertValidMessageId(id) {
  if (!/^[A-Za-z0-9_+/=-]{50,}$/.test(id)) {
    throw new Error(`ID de message invalide : "${id}". As-tu utilisé le champ "id" (et non "@odata.etag") retourné par m365_mail_list ?`);
  }
}

async function findInChildFolders(parentId, needle, user) {
  const data = await graph(
    `/users/${user}/mailFolders/${encodeURIComponent(parentId)}/childFolders?$top=200&$select=id,displayName`
  );
  for (const folder of (data.value || [])) {
    if (folder.displayName.toLowerCase() === needle) return folder.id;
    const found = await findInChildFolders(folder.id, needle, user);
    if (found) return found;
  }
  return null;
}

function ok(obj) {
  const structured = obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? obj : { items: obj };
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    structuredContent: structured,
  };
}

function registerGraphTools(server) {
  server.tool('m365_auth', 'Vérifier que les credentials M365 sont valides',
    {
      user: z.string().describe('Email du compte M365 (ex: simon@savoca.fr)')
    },
    async ({ user }) => {
      const missing = ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET'].filter(k => !process.env[k]);
      if (missing.length) return ok({ error: `Variables manquantes : ${missing.join(', ')}` });
      try {
        const userInfo = await graph(`/users/${user}?$select=displayName,mail,userPrincipalName`);
        return ok({ status: 'Auth OK', displayName: userInfo.displayName, mail: userInfo.mail });
      } catch (e) {
        return ok({ error: `Auth KO — ${e.message}` });
      }
    }
  );

  server.tool(
    'm365_mail_folders',
    'Liste les dossiers mail M365 (1 niveau). Omets `folder` pour la racine ; descends en repassant l\'`id` d\'un dossier retourné.',
    {
      user: z.string().describe('Email du compte M365'),
      folder: z.string().optional().describe('ID du dossier parent (ou nom canonique : inbox, archive…) — omis = racine. Pas de chemin.'),
    },
    async ({ user, folder } = {}) => {
      let url;
      if (folder) {
        assertFolderId(folder);
        url = `/users/${user}/mailFolders/${encodeURIComponent(folder)}/childFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount`;
      } else {
        url = `/users/${user}/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount`;
      }
      const data = await graph(url);
      return ok(data.value);
    }
  );

  server.tool(
    'm365_mail_folder_exists',
    'Vérifie si un dossier mail M365 existe (par nom ou chemin, ex: "Associations/Bodega"), sans lever d\'erreur',
    {
      user: z.string().describe('Email du compte M365'),
      path: z.string().describe('Nom ou chemin du dossier à vérifier'),
    },
    async ({ user, path }) => {
      const id = await findFolderId(path, user);
      return ok(id ? { exists: true, id, path } : { exists: false, path });
    }
  );

  server.tool(
    'm365_mail_folder_create',
    'Crée un dossier mail M365 nommé `name` sous `parent_id` (racine si absent). Idempotent : renvoie le dossier existant s\'il porte déjà ce nom. Un seul niveau — pour imbriquer, crée le parent puis réutilise son id.',
    {
      user: z.string().describe('Email du compte M365'),
      name: z.string().describe('Nom (displayName) du dossier à créer'),
      parent_id: z.string().optional().describe('ID du dossier parent (via m365_mail_folders / m365_mail_folder_exists) — omis = racine. Pas de chemin.'),
    },
    async ({ user, name, parent_id }) => {
      if (parent_id) assertFolderId(parent_id);
      const result = await createFolder(name, parent_id, user);
      return ok(result);
    }
  );

  server.tool(
    'm365_mail_list',
    'Liste les messages d\'un dossier mail M365',
    {
      user: z.string().describe('Email du compte M365'),
      folder: z.string().optional().describe('ID du dossier (ou nom canonique : inbox, archive…) — défaut : inbox. Pas de chemin.'),
      limit: z.number().int().min(1).max(50).optional().describe('Nombre de messages (défaut : 20)'),
      filter: z.string().optional().describe('Filtre OData, ex: isRead eq false'),
    },
    async ({ user, folder = 'inbox', limit = 20, filter } = {}) => {
      assertFolderId(folder);
      let url = `/users/${user}/mailFolders/${encodeURIComponent(folder)}/messages?$top=${limit}&$select=id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview`;
      if (filter) url += `&$filter=${encodeURIComponent(filter)}`;
      url += '&$orderby=receivedDateTime desc';
      const data = await graph(url);
      const messages = (data.value || []).map(({ '@odata.etag': _etag, ...rest }) => rest);
      return ok(messages);
    }
  );

  server.tool(
    'm365_mail_get',
    'Récupère le contenu complet d\'un message M365 (corps HTML + métadonnées)',
    {
      user: z.string().describe('Email du compte M365'),
      id: z.string().describe('ID du message (obtenu via m365_mail_list)'),
    },
    async ({ user, id }) => {
      assertValidMessageId(id);
      const msg = await graph(`/users/${user}/messages/${encodeURIComponent(id)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,body`);
      return ok(msg);
    }
  );

  server.tool(
    'm365_mail_move',
    'Déplace un message vers un dossier identifié par son ID (via m365_mail_folders / m365_mail_folder_exists)',
    {
      user: z.string().describe('Email du compte M365'),
      id: z.string().describe('ID du message'),
      destination_id: z.string().describe('ID du dossier de destination (ou nom canonique : archive, deleteditems…). Pas de chemin.'),
    },
    async ({ user, id, destination_id }) => {
      assertValidMessageId(id);
      assertFolderId(destination_id);
      const result = await graph(`/users/${user}/messages/${encodeURIComponent(id)}/move`, {
        method: 'POST',
        body: JSON.stringify({ destinationId: destination_id }),
      });
      return ok({ moved: true, newId: result.id, destination_id });
    }
  );

  server.tool(
    'm365_mail_delete',
    'Supprime définitivement un message M365',
    {
      user: z.string().describe('Email du compte M365'),
      id: z.string().describe('ID du message'),
    },
    async ({ user, id }) => {
      assertValidMessageId(id);
      await graph(`/users/${user}/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return ok({ deleted: true, id });
    }
  );

  server.tool(
    'm365_calendar',
    'Événements à venir dans tous les calendriers M365',
    {
      user: z.string().describe('Email du compte M365'),
      days: z.number().int().min(1).max(90).optional().describe('Horizon en jours (défaut : 7)'),
    },
    async ({ user, days = 7 } = {}) => {
      const start = new Date().toISOString();
      const end = new Date(Date.now() + days * 86400000).toISOString();
      const cals = await graph(`/users/${user}/calendars?$select=id,name`);
      const events = [];
      for (const cal of cals.value) {
        const data = await graph(
          `/users/${user}/calendars/${cal.id}/calendarView?startDateTime=${start}&endDateTime=${end}&$select=subject,start,end,location,organizer&$orderby=start/dateTime`
        );
        for (const ev of data.value) events.push({ calendar: cal.name, ...ev });
      }
      events.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));
      return ok(events);
    }
  );

  server.tool(
    'm365_contacts',
    'Liste ou recherche les contacts M365',
    {
      user: z.string().describe('Email du compte M365'),
      search: z.string().optional().describe('Texte à rechercher dans le nom ou l\'email'),
      limit: z.number().int().min(1).max(100).optional().describe('Nombre de contacts (défaut : 50)'),
    },
    async ({ user, search, limit = 50 } = {}) => {
      let url = `/users/${user}/contacts?$top=${limit}&$select=displayName,emailAddresses,mobilePhone,businessPhones`;
      if (search) url += `&$search="${encodeURIComponent(search)}"`;
      else url += '&$orderby=displayName';
      const headers = search ? { ConsistencyLevel: 'eventual' } : {};
      const data = await graph(url, { headers });
      return ok(data.value);
    }
  );

  server.tool(
    'm365_todo_lists',
    'Liste toutes les listes To Do Microsoft',
    {
      user: z.string().describe('Email du compte M365'),
    },
    async ({ user }) => {
      const data = await graph(`/users/${user}/todo/lists`);
      return ok(data.value);
    }
  );

  server.tool(
    'm365_todo_tasks',
    'Liste les tâches d\'une liste To Do',
    {
      user: z.string().describe('Email du compte M365'),
      list_id: z.string().describe('ID de la liste To Do'),
      status: z.enum(['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred']).optional().describe('Filtrer par statut'),
      limit: z.number().int().min(1).max(100).optional().default(50).describe('Nombre de tâches'),
    },
    async ({ user, list_id, status, limit = 50 }) => {
      const url = `/users/${user}/todo/lists/${encodeURIComponent(list_id)}/tasks`;
      const params = new URLSearchParams({ $top: limit });
      if (status) params.append('$filter', `status eq '${status}'`);
      const data = await graph(`${url}?${params}`);
      return ok(data.value);
    }
  );

  server.tool(
    'm365_todo_task_create',
    'Crée une tâche dans une liste To Do',
    {
      user: z.string().describe('Email du compte M365'),
      list_id: z.string().describe('ID de la liste To Do'),
      title: z.string().describe('Titre de la tâche'),
      content: z.string().optional().describe('Description (corps de la tâche)'),
      importance: z.enum(['low', 'normal', 'high']).optional().default('normal').describe('Importance'),
      due_date: z.string().optional().describe('Date d\'échéance (ISO format YYYY-MM-DD)'),
      status: z.enum(['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred']).optional().default('notStarted').describe('Statut initial'),
    },
    async ({ user, list_id, title, content, importance = 'normal', due_date, status = 'notStarted' }) => {
      const body = { title, importance, status };
      if (content) body.body = { content, contentType: 'text' };
      if (due_date) body.dueDateTime = { dateTime: `${due_date}T00:00:00.0000000`, timeZone: 'UTC' };
      const result = await graph(`/users/${user}/todo/lists/${encodeURIComponent(list_id)}/tasks`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return ok({ id: result.id, title: result.title, status: result.status });
    }
  );

  server.tool(
    'm365_todo_task_update',
    'Met à jour une tâche dans une liste To Do',
    {
      user: z.string().describe('Email du compte M365'),
      list_id: z.string().describe('ID de la liste To Do'),
      task_id: z.string().describe('ID de la tâche'),
      title: z.string().optional().describe('Nouveau titre'),
      content: z.string().optional().describe('Nouvelle description'),
      importance: z.enum(['low', 'normal', 'high']).optional().describe('Nouvelle importance'),
      due_date: z.string().optional().describe('Nouvelle date d\'échéance (ISO format YYYY-MM-DD)'),
      status: z.enum(['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred']).optional().describe('Nouveau statut'),
    },
    async ({ user, list_id, task_id, title, content, importance, due_date, status }) => {
      const body = {};
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.body = { content, contentType: 'text' };
      if (importance !== undefined) body.importance = importance;
      if (due_date !== undefined) body.dueDateTime = { dateTime: `${due_date}T00:00:00.0000000`, timeZone: 'UTC' };
      if (status !== undefined) body.status = status;
      const result = await graph(`/users/${user}/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return ok({ id: result.id, title: result.title, status: result.status });
    }
  );

  server.tool(
    'm365_todo_task_delete',
    'Supprime une tâche d\'une liste To Do',
    {
      user: z.string().describe('Email du compte M365'),
      list_id: z.string().describe('ID de la liste To Do'),
      task_id: z.string().describe('ID de la tâche'),
    },
    async ({ user, list_id, task_id }) => {
      await graph(`/users/${user}/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}`, { method: 'DELETE' });
      return ok({ deleted: true, task_id });
    }
  );
}

module.exports = { registerGraphTools };
