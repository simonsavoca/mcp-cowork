const https = require('https');
const { URL } = require('url');
const { z } = require('zod');
const querystring = require('querystring');

// Config from env vars
const NAS_HOST = process.env.SYNOLOGY_NAS_HOST;
const NAS_PORT = process.env.SYNOLOGY_NAS_PORT || '5001';
const NAS_USER = process.env.SYNOLOGY_NAS_USER;
const NAS_PASSWORD = process.env.SYNOLOGY_NAS_PASSWORD;

// HTTPS agent with self-signed cert tolerance (DSM typically uses self-signed locally)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Generic Synology API error codes & friendly explanations
const ERROR_CODES = {
  100: 'Erreur inconnue du serveur',
  101: 'Paramètre manquant ou API mal formée',
  102: 'API introuvable — vérifier que le NAS a terminé son démarrage/mise à jour, ou que l\'IP n\'est pas bloquée par Auto Block (Contrôle Panneau → Sécurité → Protection)',
  103: 'Méthode d\'API inexistante',
  104: 'Version d\'API non supportée pour cette méthode',
  105: 'Votre session/compte n\'a pas les permissions requises',
  106: 'Session expirée',
  107: 'Session interrompue (double login détecté)',
};

// Make HTTPS request to DSM, return parsed JSON
function request(path, query = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    let fullPath = path;
    let body = null;

    if (method === 'GET') {
      const qs = querystring.stringify(query);
      fullPath = qs ? `${path}?${qs}` : path;
    } else if (method === 'POST') {
      body = querystring.stringify(query);
    }

    const options = {
      hostname: NAS_HOST,
      port: NAS_PORT,
      path: fullPath,
      method: method,
      agent: httpsAgent,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };

    if (body) {
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error(`Failed to parse JSON response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout to ${NAS_HOST}:${NAS_PORT}`));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// Login to DSM, return { sid, synotoken }
// Note: version=6 is correct for DSM 7 (Synology's official recommendation; no need to bump to 7)
async function login() {
  const query = {
    api: 'SYNO.API.Auth',
    version: '6',
    method: 'login',
    account: NAS_USER,
    passwd: NAS_PASSWORD,
    session: 'FileStation',
    format: 'sid',
  };

  // Use POST for auth (more reliable than GET)
  const res = await request('/webapi/entry.cgi', query, 'POST');

  // Debug: log full response if login fails
  if (!res.success) {
    const errorCode = res.error?.code || 'unknown';
    const friendlyMsg = ERROR_CODES[errorCode] || `Erreur ${errorCode}`;
    console.error(`[Synology] Login failed:`, JSON.stringify(res, null, 2));
    throw new Error(`DSM login failed (code ${errorCode}): ${friendlyMsg}`);
  }

  return {
    sid: res.data.sid,
    synotoken: res.data.synotoken || null,
  };
}

// Logout from DSM
async function logout(sid) {
  const query = {
    api: 'SYNO.API.Auth',
    version: '6',
    method: 'logout',
    session: 'FileStation',
    _sid: sid,
  };

  await request('/webapi/entry.cgi', query);
}

// Make an authenticated DSM API call
async function call(apiName, method, version, params, sid) {
  const query = {
    api: apiName,
    version: version || '1',
    method,
    _sid: sid,
    ...params,
  };

  const res = await request('/webapi/entry.cgi', query);

  if (!res.success) {
    const errorCode = res.error?.code || 'unknown';
    const friendlyMsg = ERROR_CODES[errorCode] || `Erreur ${errorCode}`;
    throw new Error(`${apiName} failed (code ${errorCode}): ${friendlyMsg}`);
  }

  return res.data;
}

// Discover available APIs without authentication (diagnostic tool)
async function discover() {
  const query = {
    api: 'SYNO.API.Info',
    method: 'query',
    version: '1',
  };

  const res = await request('/webapi/entry.cgi', query);

  if (!res.success) {
    const errorCode = res.error?.code || 'unknown';
    const friendlyMsg = ERROR_CODES[errorCode] || `Erreur ${errorCode}`;
    throw new Error(`SYNO.API.Info discovery failed (code ${errorCode}): ${friendlyMsg}`);
  }

  return res.data;
}

// Wrapper: login → execute fn → logout (with finally guarantee)
async function withSession(fn) {
  let session = null;
  try {
    session = await login();
    return await fn(session.sid);
  } finally {
    if (session) {
      try {
        await logout(session.sid);
      } catch (e) {
        // Ignore logout errors, session will expire anyway
      }
    }
  }
}

// Response formatter following mcp-cowork conventions
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

function registerSynologyTools(server) {
  // Discover available APIs (no auth required) — diagnostic tool
  server.tool(
    'synology_discover',
    'Découvrir les APIs disponibles sur le NAS (sans authentification) — diagnostic',
    {
      search: z.string().optional().describe('Filtrer les APIs par nom (ex: "Core.System" ou "FileStation")'),
    },
    async ({ search }) => {
      const missing = ['SYNOLOGY_NAS_HOST'].filter(k => !process.env[k]);
      if (missing.length) {
        return ok(`Variables d'env manquantes : ${missing.join(', ')}`);
      }

      try {
        const data = await discover();
        let apis = Object.keys(data).sort();

        if (search) {
          apis = apis.filter(a => a.toUpperCase().includes(search.toUpperCase()));
        }

        if (apis.length === 0) {
          return ok(`Aucune API trouvée correspondant à "${search}"`);
        }

        const limit = search ? 100 : 20; // Show more results if filtering
        const shown = apis.slice(0, limit);
        const msg = `${shown.length === apis.length ? 'API discovery OK' : `API discovery OK (affichage limité à ${limit})`} — ${apis.length} résultat(s)${search ? ` pour "${search}"` : ''} (sur ${Object.keys(data).length} total):\n${shown.map(a => `  • ${a} — ${JSON.stringify(data[a])}`).join('\n')}`;
        return ok(msg);
      } catch (e) {
        return ok(`Discovery KO — ${e.message}`);
      }
    }
  );

  // Validate env vars and test login
  server.tool(
    'synology_auth',
    'Vérifier que les credentials Synology DSM sont valides (teste login/logout)',
    {},
    async () => {
      const missing = ['SYNOLOGY_NAS_HOST', 'SYNOLOGY_NAS_USER', 'SYNOLOGY_NAS_PASSWORD'].filter(k => !process.env[k]);
      if (missing.length) {
        return ok(`Variables d'env manquantes : ${missing.join(', ')}`);
      }

      try {
        const data = await withSession(async (sid) => {
          return await call('SYNO.Core.System', 'info', '3', {}, sid);
        });

        const msg = `Auth OK — DSM ${data.version} (${data.model}) [firmware: ${data.firmware_ver}]`;
        return ok(msg);
      } catch (e) {
        return ok(`Auth KO — ${e.message}`);
      }
    }
  );

  // System info: model, version, uptime, temperature
  server.tool(
    'synology_system_info',
    'Info système du NAS (modèle, version DSM, uptime, température CPU)',
    {},
    async () => {
      try {
        const data = await withSession(async (sid) => {
          return await call('SYNO.Core.System', 'info', '3', {}, sid);
        });

        return ok(data);
      } catch (e) {
        return ok(`Error: ${e.message}`);
      }
    }
  );

  // System utilization: CPU, memory, network in real-time
  server.tool(
    'synology_system_utilization',
    'Utilisation système en direct (CPU, RAM, E/S réseau, temp disque)',
    {},
    async () => {
      try {
        const data = await withSession(async (sid) => {
          return await call('SYNO.Core.System.Utilization', 'get', '1', {}, sid);
        });

        return ok(data);
      } catch (e) {
        return ok(`Error: ${e.message}`);
      }
    }
  );

  // Storage status: volumes, RAID health, disk status, used/total space
  server.tool(
    'synology_storage_status',
    'Statut stockage (volumes, RAID, disques, espace utilisé/total)',
    {},
    async () => {
      try {
        const data = await withSession(async (sid) => {
          return await call('SYNO.Storage.CGI.Storage', 'load_info', '1', {}, sid);
        });

        return ok(data);
      } catch (e) {
        return ok(`Error: ${e.message}`);
      }
    }
  );
}

module.exports = { registerSynologyTools };
