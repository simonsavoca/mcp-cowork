const fs = require("fs");
const path = require("path");
const { createServer } = require("./registry");

const MODULES = [
  {
    name: "GitHub",
    tools: ["github_auth", "github_repos", "github_issues", "github_issue_get", "github_issue_create", "github_issue_comment", "github_file"],
    requiredEnv: ["GITHUB_PERSO_TOKEN"],
    optionalEnv: ["GITHUB_DEFAULT_OWNER"],
  },
  {
    name: "Microsoft 365 / Graph",
    tools: ["m365_auth", "m365_mail_folders", "m365_mail_list", "m365_mail_get", "m365_mail_move", "m365_mail_delete", "m365_calendar", "m365_contacts", "m365_todo_lists", "m365_todo_tasks", "m365_todo_task_create", "m365_todo_task_update", "m365_todo_task_delete"],
    requiredEnv: ["M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_SECRET"],
  },
  {
    name: "Google",
    tools: ["google_auth", "google_auth_url", "google_contacts", "google_mail_profile", "google_mail_list", "google_mail_get", "google_calendar_list", "google_calendar_events", "google_calendar_event_create", "google_calendar_event_update", "google_calendar_event_delete"],
    requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    optionalEnv: ["GOOGLE_REFRESH_TOKEN"],
  },
  {
    name: "Facebook / Meta",
    tools: ["facebook_auth", "facebook_auth_url", "facebook_profile", "facebook_posts", "facebook_pages", "facebook_page_feed", "facebook_page_post", "facebook_page_photo", "facebook_page_post_update", "facebook_page_post_delete", "facebook_page_comments", "facebook_page_comment_reply", "facebook_page_insights"],
    requiredEnv: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
    optionalEnv: ["FACEBOOK_USER_TOKEN", "FACEBOOK_API_VERSION"],
    privacy: "facebook",
  },
  {
    name: "LinkedIn",
    tools: ["linkedin_auth", "linkedin_auth_url", "linkedin_profile", "linkedin_post_create"],
    requiredEnv: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    optionalEnv: ["LINKEDIN_ACCESS_TOKEN", "LINKEDIN_API_VERSION"],
    privacy: "linkedin",
  },
  {
    name: "OVH",
    tools: ["ovh_auth", "ovh_list_domains", "ovh_domain_info", "ovh_list_dns_records", "ovh_get_dns_record"],
    requiredEnv: ["OVH_MAIN_APP_KEY", "OVH_MAIN_APP_SECRET"],
    optionalEnv: ["OVH_MAIN_CONSUMER_KEY"],
  },
  {
    name: "o2switch (cPanel)",
    tools: ["o2switch_auth", "o2switch_email_list", "o2switch_email_create", "o2switch_email_delete", "o2switch_email_forwarders", "o2switch_mailing_lists", "o2switch_ftp_list", "o2switch_ftp_create", "o2switch_ftp_delete", "o2switch_db_list", "o2switch_db_create", "o2switch_db_users", "o2switch_db_user_create", "o2switch_domains", "o2switch_subdomain_list", "o2switch_subdomain_create", "o2switch_subdomain_delete", "o2switch_dns_zone", "o2switch_ssl_list", "o2switch_ssl_autossl", "o2switch_git_repos", "o2switch_php_version", "o2switch_nodejs_apps", "o2switch_apps_list"],
    requiredEnv: ["O2SWITCH_HOST", "O2SWITCH_API_USER", "O2SWITCH_API_TOKEN", "O2SWITCH_PASSWORD"],
  },
  {
    name: "Steam",
    tools: ["steam_auth", "steam_profile", "steam_level", "steam_games", "steam_recent", "steam_achievements", "steam_friends"],
    requiredEnv: ["STEAM_API_KEY", "STEAM_ID"],
  },
  {
    name: "WhatsApp",
    tools: ["whatsapp_auth", "whatsapp_recent", "whatsapp_unread", "whatsapp_send", "whatsapp_mark_read", "whatsapp_archive", "whatsapp_join_group"],
    requiredEnv: [],
    externalDep: "whatsapp-daemon (pm2 process)",
  },
  {
    name: "Pronote",
    tools: ["pronote_grades", "pronote_timetable", "pronote_absences", "pronote_homework", "pronote_bulletin"],
    requiredEnv: ["EDUCONNECT_LOGIN", "EDUCONNECT_PASSWORD", "PRONOTE_QR_PIN"],
    optionalEnv: ["PYTHON_CMD", "NEO_ENT_URL"],
  },
  {
    name: "NEO (ENT scolaire)",
    tools: ["neo_auth", "neo_messages", "neo_inbox", "neo_inbox_count", "neo_message_get", "neo_message_delete", "neo_homework", "neo_agenda"],
    requiredEnv: ["EDUCONNECT_LOGIN", "EDUCONNECT_PASSWORD"],
    optionalEnv: ["NEO_ENT_URL"],
  },
  {
    name: "PRIM / IDFM (transport)",
    tools: ["prim_auth", "prim_search_stop", "prim_search_line", "prim_departures", "prim_line_routes", "prim_line_stops", "prim_journey", "prim_disruptions"],
    requiredEnv: ["PRIM_API_KEY"],
  },
  {
    name: "Synology NAS",
    tools: ["synology_discover", "synology_auth", "synology_system_info", "synology_system_utilization", "synology_storage_status"],
    requiredEnv: ["SYNOLOGY_NAS_HOST", "SYNOLOGY_NAS_USER", "SYNOLOGY_NAS_PASSWORD"],
    optionalEnv: ["SYNOLOGY_NAS_PORT"],
  },
  {
    name: "OSRM (itinéraires)",
    tools: ["osrm_geocode", "osrm_directions"],
    requiredEnv: [],
    note: "Public API (no config required)",
  },
  {
    name: "Pushover (notifications)",
    tools: ["pushover_auth", "pushover_send"],
    requiredEnv: ["PUSHOVER_APP_TOKEN", "PUSHOVER_USER_KEY"],
  },
  {
    name: "ntfy (notifications)",
    tools: ["ntfy_auth", "ntfy_send", "ntfy_poll"],
    requiredEnv: [],
    optionalEnv: ["NTFY_SERVER", "NTFY_TOPIC", "NTFY_TOKEN", "NTFY_USERNAME", "NTFY_PASSWORD"],
    note: "Works with public ntfy.sh or self-hosted server",
  },
];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Les descriptions vivent déjà dans modules/*.js (2e argument de server.tool()).
// On les récupère depuis un McpServer jetable plutôt que de les dupliquer ici
// (createServer() est déjà rappelé sans coût réel à chaque session HTTP, voir modules/registry.js).
let toolDescriptionsCache = null;
function getToolDescriptions() {
  if (!toolDescriptionsCache) {
    toolDescriptionsCache = {};
    const tmp = createServer();
    for (const [name, tool] of Object.entries(tmp._registeredTools)) {
      toolDescriptionsCache[name] = tool.description;
    }
  }
  return toolDescriptionsCache;
}

function renderStatusPage(data) {
  const {
    version,
    uptime,
    startTime,
    publicUrl,
    port,
    activeSessions,
    oauthStats,
    gateSessionsCount,
    modules,
  } = data;

  const uptimeText = uptime < 60 ? `${uptime.toFixed(1)}s` : uptime < 3600 ? `${(uptime / 60).toFixed(1)}m` : `${(uptime / 3600).toFixed(1)}h`;

  const moduleRows = modules.map(m => {
    const configStatus = m.isConfigured ? '✓ Configuré' : '✗ Non configuré';
    const configClass = m.isConfigured ? 'configured' : 'not-configured';
    const note = m.note ? ` <span class="note">(${escapeHtml(m.note)})</span>` : '';
    const externalNote = m.externalDep ? ` <span class="external">[${escapeHtml(m.externalDep)}]</span>` : '';
    const privacyLink = m.privacy ? ` <a class="privacy-link" href="/privacy/${escapeHtml(m.privacy)}" target="_blank" rel="noopener">📄 confidentialité</a>` : '';
    const toolRows = m.toolDetails.map(t => `
          <tr>
            <td><code>${escapeHtml(t.name)}</code></td>
            <td>${escapeHtml(t.description)}</td>
          </tr>`).join('');
    return `
    <tr>
      <td><strong>${escapeHtml(m.name)}</strong></td>
      <td><span class="${configClass}">${configStatus}</span>${note}${externalNote}${privacyLink}</td>
      <td>
        <details>
          <summary>${m.toolCount} tool${m.toolCount > 1 ? 's' : ''}</summary>
          <table class="tools-table">
            <thead><tr><th>Nom</th><th>Description</th></tr></thead>
            <tbody>${toolRows}</tbody>
          </table>
        </details>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>mcp-cowork — Statut</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f1115;
      color: #e5e7eb;
      padding: 20px;
      min-height: 100vh;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { font-size: 28px; margin-bottom: 8px; font-weight: 600; }
    .subtitle { color: #8b93a3; font-size: 14px; margin-bottom: 24px; }
    .section {
      background: #171a21;
      border: 1px solid #262b35;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .section h2 {
      font-size: 16px;
      margin-bottom: 12px;
      color: #25d366;
      border-bottom: 1px solid #262b35;
      padding-bottom: 8px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .stat {
      background: #0f1115;
      border: 1px solid #262b35;
      border-radius: 6px;
      padding: 12px;
    }
    .stat-label { font-size: 12px; color: #8b93a3; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-value { font-size: 24px; font-weight: 600; margin-top: 6px; font-variant-numeric: tabular-nums; }
    .stat-unit { font-size: 12px; color: #8b93a3; }
    .memory-warning {
      background: #2a2a2a;
      border-left: 3px solid #d97706;
      padding: 12px;
      margin-top: 12px;
      font-size: 13px;
      color: #fbbf24;
      border-radius: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    table th {
      text-align: left;
      padding: 10px;
      background: #0f1115;
      border-bottom: 2px solid #262b35;
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #8b93a3;
    }
    table td {
      padding: 10px;
      border-bottom: 1px solid #262b35;
    }
    table tr:hover { background: #0f1115; }
    details summary { cursor: pointer; color: #64b5f6; }
    details[open] summary { margin-bottom: 8px; }
    .tools-table { margin-top: 4px; font-size: 13px; }
    .tools-table th, .tools-table td { padding: 6px 8px; }
    .tools-table code { color: #25d366; }
    .configured { color: #25d366; font-weight: 500; }
    .not-configured { color: #ef5350; font-weight: 500; }
    .note { font-size: 12px; color: #8b93a3; }
    .external { font-size: 12px; color: #64b5f6; }
    .privacy-link { font-size: 12px; margin-left: 6px; white-space: nowrap; }
    .info-box {
      background: #1a4d2e;
      border: 1px solid #25d366;
      border-radius: 6px;
      padding: 12px;
      margin-top: 12px;
      font-size: 13px;
      color: #25d366;
    }
    .warn-box {
      background: #4a2a2a;
      border: 1px solid #d97706;
      border-radius: 6px;
      padding: 12px;
      margin-top: 12px;
      font-size: 13px;
      color: #fbbf24;
    }
    a { color: #64b5f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .footer {
      text-align: center;
      color: #8b93a3;
      font-size: 12px;
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #262b35;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>mcp-cowork — Statut du serveur</h1>
    <p class="subtitle">Serveur MCP exposé en HTTP distant, v${escapeHtml(version)}</p>

    <!-- Serveur -->
    <div class="section">
      <h2>🖥️ Serveur</h2>
      <div class="grid">
        <div class="stat">
          <div class="stat-label">Uptime</div>
          <div class="stat-value">${uptimeText}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Démarrage</div>
          <div class="stat-value">${escapeHtml(startTime)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Port</div>
          <div class="stat-value">${escapeHtml(port)}</div>
        </div>
      </div>
      <div class="info-box">
        <strong>URL publique :</strong> ${escapeHtml(publicUrl)}
      </div>
    </div>

    <!-- Sessions actives -->
    <div class="section">
      <h2>🔌 Sessions MCP</h2>
      <div class="grid">
        <div class="stat">
          <div class="stat-label">Sessions actives</div>
          <div class="stat-value">${escapeHtml(String(activeSessions))}</div>
        </div>
      </div>
      <p style="font-size: 13px; color: #8b93a3; margin-top: 8px;">
        Sessions Streamable HTTP connectées via le SDK MCP (Claude Desktop, Claude.ai).
      </p>
    </div>

    <!-- OAuth -->
    <div class="section">
      <h2>🔐 OAuth</h2>
      <div class="grid">
        <div class="stat">
          <div class="stat-label">Clients enregistrés</div>
          <div class="stat-value">${escapeHtml(String(oauthStats.clients))}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Access tokens</div>
          <div class="stat-value">${escapeHtml(String(oauthStats.accessTokens))}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Refresh tokens</div>
          <div class="stat-value">${escapeHtml(String(oauthStats.refreshTokens))}</div>
        </div>
      </div>
      <div class="memory-warning">
        ⚠️ <strong>État en mémoire.</strong> Au redémarrage du serveur, tous les tokens OAuth sont invalidés.
        Les clients connectés (Claude Desktop/Claude.ai) devront se réauthentifier.
      </div>
    </div>

    <!-- authGate -->
    <div class="section">
      <h2>🔑 Contrôle d'accès (authGate)</h2>
      <div class="grid">
        <div class="stat">
          <div class="stat-label">Sessions persistées</div>
          <div class="stat-value">${escapeHtml(String(gateSessionsCount))}</div>
        </div>
      </div>
      <p style="font-size: 13px; color: #8b93a3; margin-top: 8px;">
        Sessions passphrase validées (cookie <code>francis_gate</code>, 30 jours).
        Persistes au redémarrage (contrairement à OAuth).
      </p>
    </div>

    <!-- Modules / Outils -->
    <div class="section">
      <h2>🧩 Modules & Outils</h2>
      <table>
        <thead>
          <tr>
            <th>Module</th>
            <th>Statut</th>
            <th>Outils</th>
          </tr>
        </thead>
        <tbody>
          ${moduleRows}
        </tbody>
      </table>
      <p style="font-size: 13px; color: #8b93a3; margin-top: 16px;">
        <strong>Configuré :</strong> toutes les variables d'environnement requises sont présentes.
        <strong>Non configuré :</strong> une ou plusieurs variables manquent (tools retourneront une erreur).
      </p>
    </div>

    <div class="footer">
      <p>Page de diagnostic en lecture seule. Aucune donnée sensible (secrets, tokens) n'est affichée.</p>
    </div>
  </div>
</body>
</html>`;
}

function registerStatusRoute(app, { transports, oauth, gateSessionsPath, port, version }) {
  const startTime = new Date();

  app.post("/status", (req, res) => {
    res.redirect(302, "/status");
  });

  app.get("/status", (req, res) => {
    const uptime = process.uptime();
    const startTimeStr = startTime.toLocaleString("fr-FR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    let gateSessionsCount = 0;
    try {
      const stored = JSON.parse(fs.readFileSync(gateSessionsPath, "utf8"));
      const now = Date.now();
      gateSessionsCount = Object.values(stored).filter((expiresAt) => expiresAt > now).length;
    } catch {
      gateSessionsCount = 0;
    }

    const oauthStats = oauth.getStats();

    const toolDescriptions = getToolDescriptions();
    const modules = MODULES.map((m) => {
      const isConfigured = m.requiredEnv.every((v) => process.env[v]);
      return {
        name: m.name,
        isConfigured,
        toolCount: m.tools.length,
        toolDetails: m.tools.map((name) => ({
          name,
          description: toolDescriptions[name] || "(description indisponible)",
        })),
        note: m.note,
        externalDep: m.externalDep,
        privacy: m.privacy,
      };
    });

    const data = {
      version,
      uptime,
      startTime: startTimeStr,
      publicUrl: process.env.MCP_PUBLIC_URL,
      port: escapeHtml(String(port)),
      activeSessions: transports.size,
      oauthStats,
      gateSessionsCount,
      modules,
    };

    const html = renderStatusPage(data);
    res.status(200).type("html").send(html);
  });
}

module.exports = { MODULES, renderStatusPage, registerStatusRoute };
