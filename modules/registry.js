const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { registerGitHubTools }   = require("./github");
const { registerGraphTools }    = require("./graph");
const { registerGoogleTools }   = require("./google");
const { registerOvhTools }      = require("./ovh");
const { registerSteamTools }    = require("./steam");
const { registerWhatsAppTools } = require("./whatsapp");
const { registerPronoteTools }  = require("./pronote");
const { registerNeoTools }      = require("./neo");
const { registerO2switchTools } = require("./o2switch");
const { registerOsrmTools }     = require("./osrm");
const { registerPrimTools }     = require("./prim");
const { registerSynologyTools } = require("./synology");
const { registerPushoverTools } = require("./pushover");
const { registerNtfyTools }     = require("./ntfy");

// Un McpServer ne peut être connecté qu'à un seul transport à la fois (sinon
// "Already connected to a transport"). Chaque session Streamable HTTP a donc
// besoin de sa propre instance — createServer() réenregistre les mêmes tools
// (stateless, aucun coût réel) sur un McpServer frais à chaque session.
function createServer() {
  const server = new McpServer({
    name: "mcp-cowork",
    version: "1.0.0",
  });

  registerGitHubTools(server);
  registerGraphTools(server);
  registerGoogleTools(server);
  registerOvhTools(server);
  registerSteamTools(server);
  registerWhatsAppTools(server);
  registerPronoteTools(server);
  registerNeoTools(server);
  registerO2switchTools(server);
  registerOsrmTools(server);
  registerPrimTools(server);
  registerSynologyTools(server);
  registerPushoverTools(server);
  registerNtfyTools(server);

  return server;
}

module.exports = { createServer };
