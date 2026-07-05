# mcp-cowork

Serveur MCP (Model Context Protocol) exposé en HTTP distant, protégé par OAuth, conçu pour être ajouté comme connecteur dans Claude Desktop ou Claude.ai ("Cowork"). Il expose une large boîte à outils d'intégrations (GitHub, Microsoft 365, Google, OVH, o2switch, Steam, WhatsApp, transport, école, NAS Synology) ainsi qu'une interface de mémoire long-terme adossée à Qdrant.

## Sommaire des tools

| Module | Tools |
|---|---|
| Mémoire (Qdrant, inline) | `collection_init`, `memory_search`, `memory_store`, `memory_update`, `memory_delete`, `session_list`, `session_history_get`, `qdrant_export` |
| GitHub | `github_auth`, `github_repos`, `github_issues`, `github_issue_get`, `github_issue_create`, `github_issue_comment`, `github_file` |
| Microsoft 365 / Graph | `m365_auth`, `m365_mail_folders`, `m365_mail_list`, `m365_mail_get`, `m365_mail_move`, `m365_mail_delete`, `m365_calendar`, `m365_contacts`, `m365_todo_lists`, `m365_todo_tasks`, `m365_todo_task_create`, `m365_todo_task_update`, `m365_todo_task_delete` |
| Google | `google_auth`, `google_auth_url`, `google_auth_callback`, `google_contacts`, `google_mail_profile`, `google_mail_list`, `google_mail_get`, `google_calendar_list`, `google_calendar_events` |
| OVH | `ovh_auth`, `ovh_list_domains`, `ovh_domain_info`, `ovh_list_dns_records`, `ovh_get_dns_record` |
| o2switch (cPanel) | `o2switch_auth`, `o2switch_email_list`, `o2switch_email_create`, `o2switch_email_delete`, `o2switch_db_list`, `o2switch_db_create`, `o2switch_db_users`, `o2switch_db_user_create`, `o2switch_domains`, `o2switch_subdomain_list`, `o2switch_subdomain_create`, `o2switch_subdomain_delete`, `o2switch_dns_zone`, `o2switch_ssl_list`, `o2switch_ssl_autossl`, `o2switch_apps_list` |
| Steam | `steam_auth`, `steam_profile`, `steam_level`, `steam_games`, `steam_recent`, `steam_achievements`, `steam_friends` |
| WhatsApp | `whatsapp_auth`, `whatsapp_recent`, `whatsapp_unread`, `whatsapp_send`, `whatsapp_mark_read`, `whatsapp_join_group` |
| Pronote | `pronote_grades`, `pronote_timetable`, `pronote_absences`, `pronote_homework`, `pronote_bulletin` |
| NEO (ENT scolaire) | `neo_auth`, `neo_messages`, `neo_inbox`, `neo_inbox_count`, `neo_message_get`, `neo_message_delete`, `neo_homework`, `neo_agenda` |
| PRIM / IDFM (transport) | `prim_auth`, `prim_search_stop`, `prim_departures`, `prim_disruptions` |
| Synology NAS | `synology_discover`, `synology_auth`, `synology_system_info`, `synology_system_utilization`, `synology_storage_status` |
| OSRM (itinéraires) | `osrm_geocode`, `osrm_directions` |

Les tools WhatsApp appellent un daemon externe séparé (`whatsapp-daemon` sur le déploiement de référence, tournant sous pm2 sur la même machine) — ce repo ne le démarre pas, il s'y connecte seulement via `modules/whatsapp.js`.

## Architecture

- **Express + Streamable HTTP** (`@modelcontextprotocol/sdk`) : chaque session MCP obtient sa propre instance `McpServer` (`createServer()` dans `index.js`). Un `McpServer` ne peut être connecté qu'à un seul transport à la fois — réenregistrer les mêmes tools à chaque session est stateless et sans coût réel.
- **OAuth** : `mcpAuthRouter` du SDK monte `/register`, `/authorize`, `/token`, `/revoke` et les endpoints `.well-known`. Seul, ce router approuve automatiquement toute demande d'autorisation (voir `modules/oauth.js`, `provider.authorize()`).
- **Contrôle d'accès réel** : `modules/authGate.js` intercepte `/authorize` avant le router OAuth et exige une passphrase (`MCP_GATE_PASSPHRASE`), avec verrouillage après 5 tentatives échouées / 15 min. C'est cette couche, pas l'OAuth du SDK, qui protège effectivement le serveur.

### ⚠️ État en mémoire (important après un restart)

Le provider OAuth (`modules/oauth.js`) et les sessions `authGate` sont **entièrement en mémoire** — un redémarrage du process invalide tous les tokens émis et toutes les sessions gate. Chaque client déjà connecté (Claude Desktop/Claude.ai) devra refaire l'authentification OAuth et repasser la passphrase après un restart ou une bascule. C'est un effet de bord attendu, pas un bug.

## Installation

```bash
git clone <repo> mcp-cowork
cd mcp-cowork
npm install
cp .env.example .env
# éditer .env avec les vraies valeurs
pm2 start ecosystem.config.js
```

## Configuration (variables d'environnement)

| Variable | Usage | Requis |
|---|---|---|
| `MCP_PUBLIC_URL` | URL publique HTTPS (issuer OAuth) — doit correspondre à l'URL du tunnel actif | oui |
| `MCP_HTTP_PORT` | Port d'écoute local (défaut 3100) | non |
| `MCP_GATE_PASSPHRASE` | Passphrase de la vraie couche de contrôle d'accès devant `/authorize` | oui |
| `QDRANT_HOST` / `QDRANT_PORT` | Instance Qdrant pour la mémoire persistante | non (défaut localhost:6333) |
| `PYTHON_CMD` | Commande Python pour les tools Pronote (nécessite `pronotepy`) | non (défaut `python`) |
| `GITHUB_DEFAULT_OWNER`, `GITHUB_PERSO_TOKEN` | GitHub | non |
| `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET` | Microsoft Graph (flux client-credentials) | non |
| `OVH_MAIN_APP_KEY`, `OVH_MAIN_APP_SECRET`, `OVH_MAIN_CONSUMER_KEY` | API OVH | non |
| `O2SWITCH_HOST`, `O2SWITCH_API_USER`, `O2SWITCH_API_TOKEN`, `O2SWITCH_PASSWORD` | cPanel o2switch | non |
| `STEAM_API_KEY`, `STEAM_ID` | Steam Web API | non |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | OAuth2 Google (Gmail, Calendar, Contacts) | non |
| `NEO_ENT_URL`, `EDUCONNECT_LOGIN`, `EDUCONNECT_PASSWORD`, `PRONOTE_QR_PIN` | ENT scolaire NEO + Pronote (EduConnect partagé) | non |
| `PRIM_API_KEY` | API PRIM/IDFM transport | non |
| `SYNOLOGY_NAS_HOST`, `SYNOLOGY_NAS_PORT`, `SYNOLOGY_NAS_USER`, `SYNOLOGY_NAS_PASSWORD` | NAS Synology DSM | non |

Toutes les intégrations sont optionnelles — sans leurs variables, les tools correspondants renvoient une erreur explicite au lieu de planter le serveur.

## Exploitation (pm2)

```bash
pm2 status
pm2 logs mcp-cowork
pm2 restart mcp-cowork
pm2 save   # à faire après tout changement pour persister au reboot
```

Changer `MCP_PUBLIC_URL` (ex : nouvelle URL de tunnel) impose un `pm2 restart` et de reconfigurer le connecteur côté client (nouvel issuer OAuth).

## Dépendances externes

- Une instance **Qdrant** accessible (`QDRANT_HOST:QDRANT_PORT`) pour la mémoire persistante.
- Un daemon **`whatsapp-daemon`** séparé (pm2, même machine) pour les tools WhatsApp.
- **Python + `pronotepy`** installés si les tools Pronote sont utilisés (`scripts/pronote.py`).
- Un tunnel HTTPS public (ex. ngrok) pointant vers `MCP_HTTP_PORT`, pour l'exposition en tant que connecteur distant.

## docs/manifest.json

Manifeste au format Desktop Extension (`.mcpb`), **non utilisé au runtime** dans ce mode de déploiement (connecteur distant + pm2). Conservé en référence pour un éventuel packaging futur en extension installable localement dans Claude Desktop.
