const { z } = require('zod');

const BASE = 'https://api.github.com';

async function gh(path, options = {}) {
  const token = process.env.GITHUB_PERSO_TOKEN;
  if (!token) throw new Error('GITHUB_PERSO_TOKEN manquant');
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function ok(obj) {
  const structured = obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? obj : { items: obj };
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    structuredContent: structured,
  };
}

function registerGitHubTools(server) {
  // Lu au démarrage du serveur (une fois l'env déjà injecté par le host MCP),
  // mais jamais throw : un GITHUB_DEFAULT_OWNER manquant ne doit pas bloquer les autres tools.
  const DEFAULT_OWNER = process.env.GITHUB_DEFAULT_OWNER;
  const ownerHint = DEFAULT_OWNER ? `défaut : ${DEFAULT_OWNER}` : 'aucun défaut configuré, requis';

  function resolveOwner(owner) {
    return owner || DEFAULT_OWNER || null;
  }

  let selfLoginCache = null;
  async function getSelfLogin() {
    if (!selfLoginCache) selfLoginCache = (await gh('/user')).login;
    return selfLoginCache;
  }

  async function isOrgAccount(ownerName) {
    try {
      return (await gh(`/users/${ownerName}`)).type === 'Organization';
    } catch {
      return false;
    }
  }

  server.tool('github_auth', 'Vérifier le token GitHub et retourner le login + scopes', {}, async () => {
    if (!process.env.GITHUB_PERSO_TOKEN) return ok({ error: 'GITHUB_PERSO_TOKEN manquant' });
    try {
      const user = await gh('/user');
      return ok({ status: 'Auth OK', login: user.login, name: user.name, public_repos: user.public_repos });
    } catch (e) {
      return ok({ error: `Auth KO — ${e.message}` });
    }
  });

  server.tool(
    'github_repos',
    'Lister les repos d\'un owner GitHub (perso ou organisation)',
    {
      owner: z.string().optional().describe(`Owner (${ownerHint})`),
      type: z.enum(['all', 'public', 'private', 'forks', 'sources']).optional().describe('Filtre de type (défaut : all)'),
      org: z.boolean().optional().describe('true/false pour forcer, sinon détecté automatiquement (user vs organisation)'),
      limit: z.number().int().min(1).max(100).optional().describe('Nombre de repos (défaut : 50)'),
    },
    async ({ owner, type = 'all', org, limit = 50 } = {}) => {
      const resolvedOwner = resolveOwner(owner);
      if (!resolvedOwner) return ok({ error: 'owner manquant : configure GITHUB_DEFAULT_OWNER ou passe owner explicitement' });

      const shape = r => ({
        name: r.name,
        full_name: r.full_name,
        private: r.private,
        language: r.language,
        description: r.description,
        updated_at: r.updated_at,
        default_branch: r.default_branch,
      });

      const isOrg = org !== undefined ? org : await isOrgAccount(resolvedOwner);

      // /users/{owner}/repos ne retourne que les repos publics, même authentifié.
      // Pour voir les repos privés du propriétaire du token, il faut passer par
      // /user/repos (endpoint "authenticated user").
      const isSelf = !isOrg && resolvedOwner.toLowerCase() === (await getSelfLogin()).toLowerCase();

      if (isSelf) {
        const isForkFilter = type === 'forks' || type === 'sources';
        const visibility = isForkFilter ? 'all' : type;
        const fetchLimit = isForkFilter ? 100 : limit;
        const repos = await gh(`/user/repos?visibility=${visibility}&affiliation=owner&per_page=${fetchLimit}&sort=updated`);
        const filtered = type === 'forks' ? repos.filter(r => r.fork)
          : type === 'sources' ? repos.filter(r => !r.fork)
          : repos;
        return ok(filtered.slice(0, limit).map(shape));
      }

      const base = isOrg ? `/orgs/${resolvedOwner}/repos` : `/users/${resolvedOwner}/repos`;
      const repos = await gh(`${base}?type=${type}&per_page=${limit}&sort=updated`);
      return ok(repos.map(shape));
    }
  );

  server.tool(
    'github_issues',
    'Lister les issues ou PRs d\'un repo GitHub',
    {
      repo: z.string().describe('Nom du repo (ex: MAIA ou simonsavoca/MAIA)'),
      owner: z.string().optional().describe(`Owner (${ownerHint})`),
      state: z.enum(['open', 'closed', 'all']).optional().describe('État (défaut : open)'),
      type: z.enum(['issues', 'pulls']).optional().describe('issues ou pulls (défaut : issues)'),
      limit: z.number().int().min(1).max(50).optional().describe('Nombre (défaut : 20)'),
    },
    async ({ repo, owner, state = 'open', type = 'issues', limit = 20 } = {}) => {
      const [resolvedOwner, resolvedRepo] = repo.includes('/') ? repo.split('/') : [resolveOwner(owner), repo];
      if (!resolvedOwner) return ok({ error: 'owner manquant : configure GITHUB_DEFAULT_OWNER ou passe owner explicitement' });
      const isPulls = type === 'pulls';
      const endpoint = isPulls
        ? `/repos/${resolvedOwner}/${resolvedRepo}/pulls?state=${state}&per_page=${limit}`
        : `/repos/${resolvedOwner}/${resolvedRepo}/issues?state=${state}&per_page=${limit}&pulls=false`;
      const items = await gh(endpoint);
      return ok(items.map(i => ({
        number: i.number,
        title: i.title,
        state: i.state,
        created_at: i.created_at,
        updated_at: i.updated_at,
        user: i.user?.login,
        labels: i.labels?.map(l => l.name),
        url: i.html_url,
      })));
    }
  );

  server.tool(
    'github_issue_get',
    'Lire le contenu complet d\'une issue ou PR GitHub',
    {
      repo: z.string().describe('Nom du repo (ex: MAIA ou simonsavoca/MAIA)'),
      number: z.number().int().describe('Numéro de l\'issue ou PR'),
      owner: z.string().optional().describe(`Owner (${ownerHint})`),
    },
    async ({ repo, number, owner }) => {
      const [resolvedOwner, resolvedRepo] = repo.includes('/') ? repo.split('/') : [resolveOwner(owner), repo];
      if (!resolvedOwner) return ok({ error: 'owner manquant : configure GITHUB_DEFAULT_OWNER ou passe owner explicitement' });
      const issue = await gh(`/repos/${resolvedOwner}/${resolvedRepo}/issues/${number}`);
      return ok({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        body: issue.body,
        user: issue.user?.login,
        labels: issue.labels?.map(l => l.name),
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        url: issue.html_url,
      });
    }
  );

  server.tool(
    'github_issue_create',
    'Créer une issue GitHub',
    {
      repo: z.string().describe('Nom du repo (ex: MAIA ou simonsavoca/MAIA)'),
      title: z.string().describe('Titre de l\'issue'),
      body: z.string().optional().describe('Corps (Markdown)'),
      labels: z.array(z.string()).optional().describe('Labels à appliquer'),
      owner: z.string().optional().describe(`Owner (${ownerHint})`),
    },
    async ({ repo, title, body, labels, owner }) => {
      const [resolvedOwner, resolvedRepo] = repo.includes('/') ? repo.split('/') : [resolveOwner(owner), repo];
      if (!resolvedOwner) return ok({ error: 'owner manquant : configure GITHUB_DEFAULT_OWNER ou passe owner explicitement' });
      const issue = await gh(`/repos/${resolvedOwner}/${resolvedRepo}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title, body, labels }),
      });
      return ok({ created: true, number: issue.number, url: issue.html_url });
    }
  );

  server.tool(
    'github_issue_comment',
    'Commenter une issue ou PR GitHub',
    {
      repo: z.string().describe('Nom du repo (ex: MAIA ou simonsavoca/MAIA)'),
      number: z.number().int().describe('Numéro de l\'issue ou PR'),
      body: z.string().describe('Contenu du commentaire (Markdown)'),
      owner: z.string().optional().describe(`Owner (${ownerHint})`),
    },
    async ({ repo, number, body, owner }) => {
      const [resolvedOwner, resolvedRepo] = repo.includes('/') ? repo.split('/') : [resolveOwner(owner), repo];
      if (!resolvedOwner) return ok({ error: 'owner manquant : configure GITHUB_DEFAULT_OWNER ou passe owner explicitement' });
      const comment = await gh(`/repos/${resolvedOwner}/${resolvedRepo}/issues/${number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      return ok({ created: true, id: comment.id, url: comment.html_url });
    }
  );

  server.tool(
    'github_file',
    'Lire un fichier dans un repo GitHub (contenu décodé)',
    {
      repo: z.string().describe('Nom du repo (ex: MAIA ou simonsavoca/MAIA)'),
      path: z.string().describe('Chemin du fichier dans le repo (ex: README.md)'),
      ref: z.string().optional().describe('Branche, tag ou commit (défaut : branche par défaut)'),
      owner: z.string().optional().describe(`Owner (${ownerHint})`),
    },
    async ({ repo, path, ref, owner }) => {
      const [resolvedOwner, resolvedRepo] = repo.includes('/') ? repo.split('/') : [resolveOwner(owner), repo];
      if (!resolvedOwner) return ok({ error: 'owner manquant : configure GITHUB_DEFAULT_OWNER ou passe owner explicitement' });
      const url = `/repos/${resolvedOwner}/${resolvedRepo}/contents/${path}${ref ? `?ref=${ref}` : ''}`;
      const file = await gh(url);
      const content = file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64').toString('utf-8')
        : file.content;
      return ok({ path: file.path, sha: file.sha, size: file.size, content });
    }
  );
}

module.exports = { registerGitHubTools };
