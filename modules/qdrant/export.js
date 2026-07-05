const fs = require("fs");
const path = require("path");
const { client, COLLECTION } = require("./client");

const FOLDER_MAP = {
  profile: "Identités",
  owner: "Identités",
  task: "Tâches",
  knowledge: {
    identity: "Identités",
    mailbox: "Email",
    service: "Services",
    organization: "Organisations",
    preference: "Préférences",
    game: "Jeux",
    repository: "Dépôts",
    residence: "Lieux",
    travel: "Voyages",
    school: "École",
    political_list: "Politique",
    project: "Projets",
    domain: "Domaines",
    database: "Bases de données",
    app: "Applications",
  },
};

const FOLDER_ICONS = {
  "Identités": "👤",
  "Tâches": "✅",
  "Services": "🔧",
  "Email": "📧",
  "Organisations": "🏢",
  "Préférences": "⚙️",
  "Jeux": "🎮",
  "Dépôts": "📦",
  "Lieux": "🏠",
  "Voyages": "✈️",
  "École": "🎓",
  "Politique": "🗳️",
  "Projets": "🚀",
  "Domaines": "🌐",
  "Bases de données": "🗄️",
  "Applications": "💿",
  "Divers": "📁",
};

// Folders that belong to the "Knowledge" type hub (everything except Identités and Tâches)
const TYPE_HUB_FOLDERS = {
  "Identités": "Identités",
  "Tâches": "Tâches",
};

const STRUCTURAL_RELATION_FIELDS = {
  game:           { scalar: ["service_name"] },
  repository:     { scalar: ["service_name"] },
  travel:         { scalar: [], array: ["participants"] },
  residence:      { scalar: ["city"] },
  political_list: { scalar: ["commune"], array: ["candidats_elus"] },
  school:         { scalar: ["school_name"] },
  domain:         { scalar: ["hosting", "registrar"] },
  database:       { scalar: ["hosting", "domain"] },
  mailbox:        { scalar: ["hosting", "domain"] },
  app:            { scalar: ["domain", "db_name", "hosting"] },
};

function getFolder(type, category) {
  if (type === "knowledge") {
    return FOLDER_MAP.knowledge[category] ?? "Divers";
  }
  return FOLDER_MAP[type] ?? "Divers";
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

function getFilename(point) {
  const p = point.payload;
  if (p.name)                                       return sanitizeFilename(p.name) + ".md";
  if (p.firstname && p.lastname)                    return sanitizeFilename(`${p.firstname} ${p.lastname}`) + ".md";
  if (p.category === "service"  && p.service_name)  return sanitizeFilename(p.service_name) + ".md";
  if (p.category === "domain"   && p.domain)        return sanitizeFilename(p.domain) + ".md";
  if (p.category === "database" && p.db_name)       return sanitizeFilename(p.db_name) + ".md";
  if (p.category === "mailbox"  && p.email)         return sanitizeFilename(p.email) + ".md";
  if (p.category === "app" && p.app_name && p.domain) return sanitizeFilename(`${p.app_name} @ ${p.domain}`) + ".md";
  if (p.title)                                      return sanitizeFilename(p.title) + ".md";
  if (p.repo_name)                                  return sanitizeFilename(p.repo_name) + ".md";
  if (p.destination)                                return sanitizeFilename(p.destination) + ".md";
  if (p.address)                                    return sanitizeFilename(p.address) + ".md";
  const cat = p.category ? `_${p.category}` : "";
  return `${p.type}${cat}_${point.id.slice(0, 8)}.md`;
}

function getSelfName(point) {
  const p = point.payload;
  if (p.name)                                       return sanitizeFilename(p.name);
  if (p.firstname && p.lastname)                    return sanitizeFilename(`${p.firstname} ${p.lastname}`);
  if (p.category === "service"  && p.service_name)  return sanitizeFilename(p.service_name);
  if (p.category === "domain"   && p.domain)        return sanitizeFilename(p.domain);
  if (p.category === "database" && p.db_name)       return sanitizeFilename(p.db_name);
  if (p.category === "mailbox"  && p.email)         return sanitizeFilename(p.email);
  if (p.category === "app" && p.app_name && p.domain) return sanitizeFilename(`${p.app_name} @ ${p.domain}`);
  if (p.title)                                      return sanitizeFilename(p.title);
  if (p.repo_name)                                  return sanitizeFilename(p.repo_name);
  if (p.destination)                                return sanitizeFilename(p.destination);
  return null;
}

const PERSON_TYPES = new Set(["profile", "owner"]);

function buildNameRegistry(points) {
  const registry = new Map();
  for (const point of points) {
    const p = point.payload;
    const canonical = getSelfName(point);
    if (!canonical) continue;
    registry.set(canonical, canonical);
    const isPerson = PERSON_TYPES.has(p.type) ||
      (p.type === "knowledge" && p.category === "identity");
    if (isPerson) {
      const spaceParts = canonical.split(" ");
      if (spaceParts.length > 1) registry.set(spaceParts[0], canonical);
    }
  }
  return registry;
}

function buildStructuralLinks(point, registry, selfName) {
  const p = point.payload;
  const links = new Set();

  const resolveToWikilink = (value) => {
    if (!value || typeof value !== "string") return;
    if (registry.has(value)) {
      const canonical = registry.get(value);
      if (canonical !== selfName) links.add(`[[${canonical}]]`);
      return;
    }
    const lower = value.toLowerCase();
    for (const [k, v] of registry) {
      if (k.toLowerCase() === lower && v !== selfName) {
        links.add(`[[${v}]]`);
        return;
      }
    }
  };

  const rules = STRUCTURAL_RELATION_FIELDS[p.category] ?? {};
  for (const field of rules.scalar ?? []) resolveToWikilink(p[field]);
  for (const field of rules.array ?? []) {
    const arr = p[field];
    if (Array.isArray(arr)) arr.forEach(resolveToWikilink);
  }
  if (p.type === "task" && p.person) resolveToWikilink(p.person);

  return [...links];
}

function injectWikilinks(text, registry, selfName) {
  let result = text;
  const entries = Array.from(registry.entries()).sort((a, b) => b[0].length - a[0].length);
  for (const [variant, canonical] of entries) {
    if (variant === selfName || canonical === selfName) continue;
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?<![\\[\\w])${escaped}(?![\\]\\w])`, "gi");
    result = result.replace(regex, () => `[[${canonical}]]`);
  }
  return result;
}

function buildFrontmatter(payload) {
  const excluded = new Set(["content", "session_id"]);
  const fields = Object.entries(payload)
    .filter(([k]) => !excluded.has(k))
    .map(([k, v]) => {
      if (typeof v === "string" && v.includes(":")) return `${k}: "${v}"`;
      return `${k}: ${JSON.stringify(v)}`;
    });
  const tags = [payload.type, payload.category, payload.status]
    .filter(Boolean)
    .map((t) => t.replace(/\s+/g, "_"));
  fields.push(`tags: [${tags.join(", ")}]`);
  return `---\n${fields.join("\n")}\n---`;
}

function writeHub(filePath, title, icon, items, countLabel) {
  const header = [
    `---`,
    `title: "${icon} ${title}"`,
    `tags: [hub]`,
    `---`,
    ``,
    `# ${icon} ${title}`,
    ``,
  ];
  const lines = items.sort().map((item) =>
    countLabel ? `- [[${item.name}]] — ${item.count} entrée${item.count > 1 ? "s" : ""}` : `- [[${item}]]`
  );
  fs.writeFileSync(filePath, header.join("\n") + lines.join("\n") + "\n", "utf8");
}

async function qdrantExport(outputDir, excludeTypes = ["session_history"]) {
  // Clear entire output directory
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });

  const excludeSet = new Set(excludeTypes);
  const points = [];
  let offset = null;
  do {
    const params = { with_payload: true, limit: 250, with_vectors: false };
    if (offset !== null) params.offset = offset;
    const result = await client.scroll(COLLECTION, params);
    for (const point of result.points) {
      if (!excludeSet.has(point.payload.type)) points.push(point);
    }
    offset = result.next_page_offset ?? null;
  } while (offset !== null);

  const registry = buildNameRegistry(points);
  const written = [];
  // folderGroups: folder → sorted basenames[]
  const folderGroups = {};

  // Write individual files
  for (const point of points) {
    const p = point.payload;
    const folder = getFolder(p.type, p.category);
    const filename = getFilename(point);
    const basename = filename.replace(/\.md$/, "");
    const selfName = getSelfName(point);

    fs.mkdirSync(path.join(outputDir, folder), { recursive: true });

    const frontmatter = buildFrontmatter(p);
    let body = injectWikilinks(p.content ?? "", registry, selfName);
    const structuralLinks = buildStructuralLinks(point, registry, selfName);
    if (structuralLinks.length > 0) {
      body += `\n\n## Liens\n\n${structuralLinks.map((l) => `- ${l}`).join("\n")}`;
    }

    fs.writeFileSync(path.join(outputDir, folder, filename), `${frontmatter}\n\n${body}\n`, "utf8");
    written.push(path.join(folder, filename));

    if (!folderGroups[folder]) folderGroups[folder] = [];
    folderGroups[folder].push(basename);
  }

  // Write hub files in _hubs/
  const hubsDir = path.join(outputDir, "_hubs");
  fs.mkdirSync(hubsDir, { recursive: true });

  const knowledgeFolders = [];

  for (const [folder, items] of Object.entries(folderGroups).sort()) {
    const icon = FOLDER_ICONS[folder] ?? "📁";
    writeHub(path.join(hubsDir, `${folder}.md`), folder, icon, items, false);
    written.push(path.join("_hubs", `${folder}.md`));

    if (!TYPE_HUB_FOLDERS[folder]) {
      knowledgeFolders.push(folder);
    }
  }

  // Knowledge type hub → links to category hubs
  const knowledgeItems = knowledgeFolders.sort().map((f) => ({
    name: f,
    count: folderGroups[f]?.length ?? 0,
  }));
  writeHub(path.join(hubsDir, "Knowledge.md"), "Knowledge", "🧠", knowledgeItems, true);
  written.push(path.join("_hubs", "Knowledge.md"));

  // HOME.md → type-level navigation
  const today = new Date().toISOString().slice(0, 10);
  const total = points.length;
  const identitesCount = folderGroups["Identités"]?.length ?? 0;
  const tachesCount    = folderGroups["Tâches"]?.length ?? 0;
  const knowledgeCount = knowledgeFolders.reduce((s, f) => s + (folderGroups[f]?.length ?? 0), 0);

  const homeLines = [
    `---`,
    `title: Francis — Mémoire`,
    `date: ${today}`,
    `tags: [index, home]`,
    `---`,
    ``,
    `# 🧠 Francis — Mémoire`,
    ``,
    `> Exporté le ${today} · ${total} entrées`,
    ``,
    `## Navigation`,
    ``,
    `- [[Identités]] — ${identitesCount} identité${identitesCount > 1 ? "s" : ""}`,
    `- [[Knowledge]] — ${knowledgeCount} entrée${knowledgeCount > 1 ? "s" : ""} · ${knowledgeFolders.length} catégories`,
    `- [[Tâches]] — ${tachesCount} tâche${tachesCount > 1 ? "s" : ""}`,
    ``,
  ];
  fs.writeFileSync(path.join(outputDir, "HOME.md"), homeLines.join("\n"), "utf8");
  written.unshift("HOME.md");

  return { exported: written.length, files: written };
}

module.exports = { qdrantExport };
