const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

module.exports = {
  apps: [
    {
      name: "mcp-cowork",
      script: "index.js",
      cwd: __dirname,
      env: {
        // Remplacer par l'URL HTTPS publique active (ex: ngrok). Sert d'issuer OAuth :
        // la changer nécessite un `pm2 restart` + reconfigurer le connecteur côté client.
        MCP_PUBLIC_URL: process.env.MCP_PUBLIC_URL,
        MCP_HTTP_PORT: process.env.MCP_HTTP_PORT || "3100",
        MCP_GATE_PASSPHRASE: process.env.MCP_GATE_PASSPHRASE,

        PYTHON_CMD: process.env.PYTHON_CMD,

        GITHUB_DEFAULT_OWNER: process.env.GITHUB_DEFAULT_OWNER,
        GITHUB_PERSO_TOKEN: process.env.GITHUB_PERSO_TOKEN,

        M365_TENANT_ID: process.env.M365_TENANT_ID,
        M365_CLIENT_ID: process.env.M365_CLIENT_ID,
        M365_CLIENT_SECRET: process.env.M365_CLIENT_SECRET,

        OVH_MAIN_APP_KEY: process.env.OVH_MAIN_APP_KEY,
        OVH_MAIN_APP_SECRET: process.env.OVH_MAIN_APP_SECRET,
        OVH_MAIN_CONSUMER_KEY: process.env.OVH_MAIN_CONSUMER_KEY,

        O2SWITCH_HOST: process.env.O2SWITCH_HOST,
        O2SWITCH_API_USER: process.env.O2SWITCH_API_USER,
        O2SWITCH_API_TOKEN: process.env.O2SWITCH_API_TOKEN,
        O2SWITCH_PASSWORD: process.env.O2SWITCH_PASSWORD,

        STEAM_API_KEY: process.env.STEAM_API_KEY,
        STEAM_ID: process.env.STEAM_ID,

        GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
        GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN,

        NEO_ENT_URL: process.env.NEO_ENT_URL,
        EDUCONNECT_LOGIN: process.env.EDUCONNECT_LOGIN,
        EDUCONNECT_PASSWORD: process.env.EDUCONNECT_PASSWORD,
        PRONOTE_QR_PIN: process.env.PRONOTE_QR_PIN,

        PRIM_API_KEY: process.env.PRIM_API_KEY,

        SYNOLOGY_NAS_HOST: process.env.SYNOLOGY_NAS_HOST,
        SYNOLOGY_NAS_PORT: process.env.SYNOLOGY_NAS_PORT,
        SYNOLOGY_NAS_USER: process.env.SYNOLOGY_NAS_USER,
        SYNOLOGY_NAS_PASSWORD: process.env.SYNOLOGY_NAS_PASSWORD,
        PUSHOVER_APP_TOKEN: process.env.PUSHOVER_APP_TOKEN,
        PUSHOVER_USER_KEY: process.env.PUSHOVER_USER_KEY
      },
    },
  ],
};
