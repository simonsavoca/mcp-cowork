const { z } = require("zod");

function cpanelAuth() {
  const host = process.env.O2SWITCH_HOST;
  const user = process.env.O2SWITCH_API_USER;
  const token = process.env.O2SWITCH_API_TOKEN;
  const password = process.env.O2SWITCH_PASSWORD;
  if (!host || !user || !token || !password) {
    throw new Error("O2SWITCH_HOST, O2SWITCH_API_USER, O2SWITCH_API_TOKEN et O2SWITCH_PASSWORD sont requis");
  }
  return { host, user, token, password };
}

async function uapi(module, fn, params = {}) {
  const { host, user, token } = cpanelAuth();
  const res = await fetch(`https://${host}:2083/execute/${module}/${fn}`, {
    method: "POST",
    headers: {
      Authorization: `cpanel ${user}:${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`cPanel API HTTP ${res.status}: ${await res.text()}`);
  const parsed = await res.json();
  if (parsed.result?.status === 0) {
    const errors = parsed.result?.errors?.join(", ") ?? "Erreur inconnue";
    throw new Error(`UAPI error: ${errors}`);
  }
  return parsed.result?.data ?? parsed;
}

async function softaculousList() {
  const { host, user, password } = cpanelAuth();
  const res = await fetch(
    `https://${host}:2083/frontend/o2switch/softaculous/index.live.php?act=installations&api=json`,
    { headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` } }
  );
  if (!res.ok) throw new Error(`Softaculous API HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // data.installations est groupé par script id (sid), chaque valeur étant elle-même un objet
  // {insid: installation}. Il faut aplatir les deux niveaux pour obtenir la liste des installs.
  const bySid = Object.values(data.installations ?? data);
  const list = bySid.flatMap((installs) => Object.values(installs));
  return list.map((v) => ({
    insid: v.insid,
    script: v.script_name ?? v.soft ?? null,
    version: v.ver,
    domain: v.softdomain,
    url: v.softurl,
    admin_url: v.adminurl ? `${String(v.softurl).replace(/\/$/, "")}/${v.adminurl}` : null,
    db: v.softdb ?? null,
  }));
}

// structuredContent doit être un objet (pas un tableau nu) : on enveloppe les tableaux.
function ok(data) {
  const structured = data !== null && typeof data === "object" && !Array.isArray(data) ? data : { items: data };
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: structured,
  };
}

function registerO2switchTools(server) {
  // Auth / statut
  server.tool(
    "o2switch_auth",
    "Tester la connexion à l'API cPanel o2switch (jeton) et voir l'usage des ressources (disque, bande passante)",
    {},
    async () => ok(await uapi("ResourceUsage", "get_usages"))
  );

  // ── Emails ──────────────────────────────────────────────────────────────
  server.tool(
    "o2switch_email_list",
    "Lister les comptes email cPanel",
    {
      domain: z.string().optional().describe("Filtrer par domaine (ex: savoca.fr)"),
    },
    async ({ domain } = {}) => ok(await uapi("Email", "list_pops", domain ? { domain } : {}))
  );

  server.tool(
    "o2switch_email_create",
    "Créer un compte email cPanel",
    {
      email: z.string().describe("Adresse email complète (ex: contact@savoca.fr)"),
      password: z.string().describe("Mot de passe du compte"),
      quota: z.number().int().optional().default(0).describe("Quota en Mo (0 = illimité)"),
    },
    async ({ email, password, quota = 0 }) => {
      const [user, domain] = email.split("@");
      return ok(await uapi("Email", "add_pop", { email: user, domain, password, quota }));
    }
  );

  server.tool(
    "o2switch_email_delete",
    "Supprimer un compte email cPanel",
    {
      email: z.string().describe("Adresse email complète (ex: contact@savoca.fr)"),
    },
    async ({ email }) => {
      const [user, domain] = email.split("@");
      return ok(await uapi("Email", "delete_pop", { email: user, domain }));
    }
  );

  // ── Bases de données ─────────────────────────────────────────────────────
  server.tool(
    "o2switch_db_list",
    "Lister les bases de données MySQL cPanel",
    {},
    async () => ok(await uapi("Mysql", "list_databases"))
  );

  server.tool(
    "o2switch_db_create",
    "Créer une base de données MySQL cPanel (le préfixe cPanel est ajouté automatiquement)",
    {
      name: z.string().describe("Nom de la base (sans préfixe)"),
    },
    async ({ name }) => ok(await uapi("Mysql", "create_database", { name }))
  );

  server.tool(
    "o2switch_db_users",
    "Lister les utilisateurs MySQL cPanel",
    {},
    async () => ok(await uapi("Mysql", "list_users"))
  );

  server.tool(
    "o2switch_db_user_create",
    "Créer un utilisateur MySQL cPanel",
    {
      name: z.string().describe("Nom de l'utilisateur (sans préfixe)"),
      password: z.string().describe("Mot de passe"),
    },
    async ({ name, password }) => ok(await uapi("Mysql", "create_user", { name, password }))
  );

  // ── Domaines ─────────────────────────────────────────────────────────────
  server.tool(
    "o2switch_domains",
    "Lister tous les domaines du compte cPanel (principal, addon, sous-domaines)",
    {},
    async () => ok(await uapi("DomainInfo", "domains_data"))
  );

  server.tool(
    "o2switch_subdomain_list",
    "Lister les sous-domaines cPanel",
    {},
    async () => ok(await uapi("SubDomain", "listsubdomains"))
  );

  server.tool(
    "o2switch_subdomain_create",
    "Créer un sous-domaine cPanel",
    {
      domain: z.string().describe("Préfixe du sous-domaine (ex: dev)"),
      rootdomain: z.string().describe("Domaine parent (ex: savoca.fr)"),
      dir: z.string().optional().describe("Dossier racine (optionnel)"),
    },
    async ({ domain, rootdomain, dir }) =>
      ok(await uapi("SubDomain", "addsubdomain", { domain, rootdomain, ...(dir ? { dir } : {}) }))
  );

  server.tool(
    "o2switch_subdomain_delete",
    "Supprimer un sous-domaine cPanel",
    {
      domain: z.string().describe("Préfixe du sous-domaine (ex: dev)"),
      rootdomain: z.string().describe("Domaine parent (ex: savoca.fr)"),
    },
    async ({ domain, rootdomain }) =>
      ok(await uapi("SubDomain", "delsubdomain", { domain, rootdomain }))
  );

  // ── DNS ──────────────────────────────────────────────────────────────────
  server.tool(
    "o2switch_dns_zone",
    "Lire la zone DNS d'un domaine cPanel",
    {
      domain: z.string().describe("Nom de domaine (ex: savoca.fr)"),
    },
    async ({ domain }) => ok(await uapi("DNS", "parse_zone", { domain }))
  );

  // ── SSL / Let's Encrypt ───────────────────────────────────────────────────
  server.tool(
    "o2switch_ssl_list",
    "Lister les certificats SSL installés sur le compte cPanel",
    {},
    async () => ok(await uapi("SSL", "list_certs"))
  );

  server.tool(
    "o2switch_ssl_autossl",
    "Déclencher AutoSSL (Let's Encrypt) pour tous les domaines du compte",
    {},
    async () => ok(await uapi("LetsEncrypt", "install_ssl_for_all_domains"))
  );

  // ── Softaculous ──────────────────────────────────────────────────────────
  server.tool(
    "o2switch_apps_list",
    "Lister les applications installées via Softaculous (API Softaculous)",
    {},
    async () => ok(await softaculousList())
  );
}

module.exports = { registerO2switchTools };
