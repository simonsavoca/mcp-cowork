const OvhClient = require('ovh');
const { z } = require('zod');

// Instancié à la première requête, pas au chargement du module : évite de crasher
// tout le serveur si OVH_MAIN_APP_KEY/SECRET manquent (le package "ovh" throw dans son constructeur).
let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.OVH_MAIN_APP_KEY || !process.env.OVH_MAIN_APP_SECRET) {
      throw new Error("Variables d'env manquantes : OVH_MAIN_APP_KEY, OVH_MAIN_APP_SECRET, OVH_MAIN_CONSUMER_KEY");
    }
    _client = new OvhClient({
      endpoint: 'ovh-eu',
      appKey: process.env.OVH_MAIN_APP_KEY,
      appSecret: process.env.OVH_MAIN_APP_SECRET,
      consumerKey: process.env.OVH_MAIN_CONSUMER_KEY,
    });
  }
  return _client;
}

const request = (method, path, params) => new Promise((resolve, reject) => {
  getClient().request(method, path, params || {}, (err, res) => {
    if (err) reject(new Error(JSON.stringify(err)));
    else resolve(res);
  });
});

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

function registerOvhTools(server) {
  server.tool('ovh_list_domains', 'Liste tous les domaines OVH du compte', {}, async () =>
    ok(await request('GET', '/domain'))
  );

  server.tool(
    'ovh_domain_info',
    "Infos d'un domaine OVH (expiry, status, contacts)",
    { name: z.string().describe('Nom de domaine, ex: savoca.fr') },
    async ({ name }) => ok(await request('GET', `/domain/${name}`))
  );

  server.tool(
    'ovh_list_dns_records',
    "Liste les IDs des enregistrements DNS d'une zone",
    {
      zone: z.string().describe('Nom de zone DNS, ex: savoca.fr'),
      fieldType: z.string().optional().describe('Filtrer par type : A, AAAA, CNAME, MX, TXT, NS...'),
    },
    async ({ zone, fieldType }) => {
      const params = fieldType ? { fieldType } : {};
      const result = await request('GET', `/domain/zone/${zone}/record`, params);
      return ok(result);
    }
  );

  server.tool(
    'ovh_get_dns_record',
    'Détail complet d\'un enregistrement DNS par ID (sous-domaine, type, cible, TTL)',
    {
      zone: z.string().describe('Nom de zone DNS, ex: savoca.fr'),
      id: z.number().describe("ID de l'enregistrement (obtenu via ovh_list_dns_records)"),
    },
    async ({ zone, id }) => ok(await request('GET', `/domain/zone/${zone}/record/${id}`))
  );

  server.tool(
    'ovh_auth',
    'Vérifier que les credentials OVH API sont valides (teste GET /me)',
    {},
    async () => {
      const missing = ['OVH_MAIN_APP_KEY', 'OVH_MAIN_APP_SECRET', 'OVH_MAIN_CONSUMER_KEY'].filter(k => !process.env[k]);
      if (missing.length) {
        return ok(`Variables d'env manquantes : ${missing.join(', ')}`);
      }
      try {
        const me = await request('GET', '/me');
        return ok(`Auth OK — NIC : ${me.nichandle} (${me.firstname} ${me.name})`);
      } catch (e) {
        return ok(`Auth KO — ${e.message}`);
      }
    }
  );
}

module.exports = { registerOvhTools };

