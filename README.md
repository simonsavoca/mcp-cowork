# mcp-cowork

Serveur MCP (Model Context Protocol) exposé en HTTP distant, protégé par OAuth, conçu pour être ajouté comme connecteur dans Claude Desktop ou Claude.ai ("Cowork"). Il expose une large boîte à outils d'intégrations (GitHub, Microsoft 365, Google, OVH, o2switch, Steam, WhatsApp, transport, école, NAS Synology, notifications Pushover/ntfy).

## Sommaire des tools

| Module | Tools |
|---|---|
| GitHub | `github_auth`, `github_repos`, `github_issues`, `github_issue_get`, `github_issue_create`, `github_issue_comment`, `github_file` |
| Microsoft 365 / Graph | `m365_auth`, `m365_mail_folders`, `m365_mail_folder_exists`, `m365_mail_folder_create`, `m365_mail_list`, `m365_mail_get`, `m365_mail_move`, `m365_mail_delete`, `m365_calendar`, `m365_contacts`, `m365_todo_lists`, `m365_todo_tasks`, `m365_todo_task_create`, `m365_todo_task_update`, `m365_todo_task_delete` |
| Google | `google_auth`, `google_auth_url`, `google_auth_callback`, `google_contacts`, `google_mail_profile`, `google_mail_list`, `google_mail_get`, `google_calendar_list`, `google_calendar_events` |
| Facebook / Meta | `facebook_auth`, `facebook_auth_url`, `facebook_auth_callback`, `facebook_profile`, `facebook_posts`, `facebook_pages`, `facebook_page_feed`, `facebook_page_post`, `facebook_page_photo`, `facebook_page_post_update`, `facebook_page_post_delete`, `facebook_page_comments`, `facebook_page_comment_reply`, `facebook_page_insights` |
| OVH | `ovh_auth`, `ovh_list_domains`, `ovh_domain_info`, `ovh_list_dns_records`, `ovh_get_dns_record` |
| o2switch (cPanel) | `o2switch_auth`, `o2switch_email_list`, `o2switch_email_create`, `o2switch_email_delete`, `o2switch_email_forwarders`, `o2switch_mailing_lists`, `o2switch_ftp_list`, `o2switch_ftp_create`, `o2switch_ftp_delete`, `o2switch_db_list`, `o2switch_db_create`, `o2switch_db_users`, `o2switch_db_user_create`, `o2switch_domains`, `o2switch_subdomain_list`, `o2switch_subdomain_create`, `o2switch_subdomain_delete`, `o2switch_dns_zone`, `o2switch_ssl_list`, `o2switch_ssl_autossl`, `o2switch_git_repos`, `o2switch_php_version`, `o2switch_nodejs_apps`, `o2switch_apps_list` |
| Steam | `steam_auth`, `steam_profile`, `steam_level`, `steam_games`, `steam_recent`, `steam_achievements`, `steam_friends` |
| WhatsApp | `whatsapp_auth`, `whatsapp_recent`, `whatsapp_unread`, `whatsapp_send`, `whatsapp_mark_read`, `whatsapp_archive`, `whatsapp_join_group` |
| Pronote | `pronote_grades`, `pronote_timetable`, `pronote_absences`, `pronote_homework`, `pronote_bulletin` |
| NEO (ENT scolaire) | `neo_auth`, `neo_messages`, `neo_inbox`, `neo_inbox_count`, `neo_message_get`, `neo_message_delete`, `neo_homework`, `neo_agenda` |
| PRIM / IDFM (transport) | `prim_auth`, `prim_search_stop`, `prim_search_line`, `prim_line_routes`, `prim_line_stops`, `prim_departures`, `prim_disruptions` |
| Synology NAS | `synology_discover`, `synology_auth`, `synology_system_info`, `synology_system_utilization`, `synology_storage_status` |
| OSRM (itinéraires) | `osrm_geocode`, `osrm_directions` |
| Pushover (notifications) | `pushover_auth`, `pushover_send` |
| ntfy (notifications) | `ntfy_auth`, `ntfy_send`, `ntfy_poll` |

Les tools WhatsApp appellent un daemon externe séparé (`whatsapp-daemon` sur le déploiement de référence, tournant sous pm2 sur la même machine) — ce repo ne le démarre pas, il s'y connecte seulement via `modules/whatsapp.js`.

## Architecture

- **Express + Streamable HTTP** (`@modelcontextprotocol/sdk`) : chaque session MCP obtient sa propre instance `McpServer` (`createServer()` dans `index.js`). Un `McpServer` ne peut être connecté qu'à un seul transport à la fois — réenregistrer les mêmes tools à chaque session est stateless et sans coût réel.
- **OAuth** : `mcpAuthRouter` du SDK monte `/register`, `/authorize`, `/token`, `/revoke` et les endpoints `.well-known`. Seul, ce router approuve automatiquement toute demande d'autorisation (voir `modules/oauth.js`, `provider.authorize()`).
- **Contrôle d'accès réel** : `modules/authGate.js` intercepte `/authorize` avant le router OAuth et exige une passphrase (`MCP_GATE_PASSPHRASE`), avec verrouillage après 5 tentatives échouées / 15 min. C'est cette couche, pas l'OAuth du SDK, qui protège effectivement le serveur.

### ⚠️ État en mémoire (important après un restart)

Le provider OAuth (`modules/oauth.js`) reste **entièrement en mémoire** — un redémarrage du process invalide tous les tokens OAuth émis, et chaque client déjà connecté (Claude Desktop/Claude.ai) devra refaire l'authentification OAuth après un restart ou une bascule. C'est un effet de bord attendu, pas un bug.

Les sessions `authGate` (issues d'une passphrase validée), elles, sont persistées dans `data/gate_sessions.json` (même mécanisme que `data/google_token.json` pour Google) : un redémarrage du process ne redemande donc plus la passphrase tant que le cookie `francis_gate` (30 jours) est encore valide.

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
| `PYTHON_CMD` | Commande Python pour les tools Pronote (nécessite `pronotepy`) | non (défaut `python`) |
| `GITHUB_DEFAULT_OWNER`, `GITHUB_PERSO_TOKEN` | GitHub | non |
| `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET` | Microsoft Graph (flux client-credentials) | non |
| `OVH_MAIN_APP_KEY`, `OVH_MAIN_APP_SECRET`, `OVH_MAIN_CONSUMER_KEY` | API OVH | non |
| `O2SWITCH_HOST`, `O2SWITCH_API_USER`, `O2SWITCH_API_TOKEN`, `O2SWITCH_PASSWORD` | cPanel o2switch | non |
| `STEAM_API_KEY`, `STEAM_ID` | Steam Web API | non |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | OAuth2 Google (Gmail, Calendar, Contacts) | non |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_USER_TOKEN`, `FACEBOOK_API_VERSION` | Facebook/Meta Graph (compte perso en lecture, gestion des Pages) — token de bootstrap via Graph API Explorer puis `facebook_auth_callback` (stocké dans `data/facebook_token.json`) | non |
| `NEO_ENT_URL`, `EDUCONNECT_LOGIN`, `EDUCONNECT_PASSWORD`, `PRONOTE_QR_PIN` | ENT scolaire NEO + Pronote (EduConnect partagé) | non |
| `PRIM_API_KEY` | API PRIM/IDFM transport | non |
| `SYNOLOGY_NAS_HOST`, `SYNOLOGY_NAS_PORT`, `SYNOLOGY_NAS_USER`, `SYNOLOGY_NAS_PASSWORD` | NAS Synology DSM | non |
| `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY` | Notifications push Pushover.net | non |
| `NTFY_SERVER`, `NTFY_TOPIC`, `NTFY_TOKEN`, `NTFY_USERNAME`, `NTFY_PASSWORD` | Notifications ntfy (ntfy.sh ou auto-hébergé ; `NTFY_TOKEN` ou `NTFY_USERNAME`/`NTFY_PASSWORD` uniquement pour un topic protégé) | non |
| `WHATSAPP_DAEMON_TOKEN` | Bearer token pour l'API du `whatsapp-daemon` externe (127.0.0.1:3099) — à récupérer via `http://127.0.0.1:3099/auth/status` après login | non |

Toutes les intégrations sont optionnelles — sans leurs variables, les tools correspondants renvoient une erreur explicite au lieu de planter le serveur.

## Exploitation (pm2)

```bash
pm2 status
pm2 logs mcp-cowork
pm2 restart mcp-cowork
pm2 save   # à faire après tout changement pour persister au reboot
```

Changer `MCP_PUBLIC_URL` (ex : nouvelle URL de tunnel) impose un `pm2 restart` et de reconfigurer le connecteur côté client (nouvel issuer OAuth).

## Page de statut

Une page de diagnostic web est disponible à l'adresse `/status` (protégée par la même passphrase que `/authorize`). Elle affiche en temps réel :

- **Serveur** : version, uptime, heure de démarrage, port, URL publique
- **Sessions MCP** : nombre de sessions Streamable HTTP actives (clients connectés via Claude Desktop/Claude.ai)
- **OAuth** : nombre de clients enregistrés, d'access tokens et de refresh tokens en mémoire (rappel : état perdu au restart)
- **authGate** : nombre de sessions passphrase validées persistées sur disque
- **Modules & Outils** : liste des 15 modules avec statut configuré/non-configuré selon les variables d'environnement présentes

La page est en **lecture seule** — aucune action déclenchable. Accès : `https://[MCP_PUBLIC_URL]/status` avec la même passphrase que la protection OAuth.

## Pages de confidentialité (`/privacy`)

Des pages de confidentialité **publiques** (hors passphrase) sont exposées pour les plateformes qui l'exigent (ex. Meta requiert une Privacy Policy URL pour l'app Facebook) :

- `/privacy` — politique générique
- `/privacy/:service` — politique par service (ex. `/privacy/facebook`)

Contenu adapté à un usage strictement personnel, sans garantie. À renseigner comme Privacy Policy URL de l'app Meta : `https://[MCP_PUBLIC_URL]/privacy/facebook`.

## Dépendances externes

- Un daemon **`whatsapp-daemon`** séparé (pm2, même machine) pour les tools WhatsApp.
- **Python + `pronotepy`** installés si les tools Pronote sont utilisés (`scripts/pronote.py`).
- Un tunnel HTTPS public (ex. ngrok) pointant vers `MCP_HTTP_PORT`, pour l'exposition en tant que connecteur distant.

## docs/manifest.json

Manifeste au format Desktop Extension (`.mcpb`), **non utilisé au runtime** dans ce mode de déploiement (connecteur distant + pm2). Conservé en référence pour un éventuel packaging futur en extension installable localement dans Claude Desktop.
