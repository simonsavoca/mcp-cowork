const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = require("@modelcontextprotocol/sdk/server/auth/router.js");
const { requireBearerAuth } = require("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");
const { randomUUID } = require("node:crypto");
const express = require("express");
const { z } = require("zod");
const { provider: oauthProvider } = require("./modules/oauth");
const { authGate } = require("./modules/authGate");
const { registerGitHubTools }   = require("./modules/github");
const { registerGraphTools }    = require("./modules/graph");
const { registerGoogleTools }   = require("./modules/google");
const { registerOvhTools }      = require("./modules/ovh");
const { registerSteamTools }    = require("./modules/steam");
const { registerWhatsAppTools } = require("./modules/whatsapp");
const { registerPronoteTools }  = require("./modules/pronote");
const { registerNeoTools }      = require("./modules/neo");
const { registerO2switchTools } = require("./modules/o2switch");
const { registerOsrmTools }     = require("./modules/osrm");
const { registerPrimTools }     = require("./modules/prim");
const { registerSynologyTools } = require("./modules/synology");
const { registerPushoverTools } = require("./modules/pushover");

const PUBLIC_URL = process.env.MCP_PUBLIC_URL;
if (!PUBLIC_URL) {
  process.stderr.write("mcp-cowork fatal: MCP_PUBLIC_URL manquant — requis comme issuer OAuth pour un serveur exposé publiquement.\n");
  process.exit(1);
}
const PORT = parseInt(process.env.MCP_HTTP_PORT ?? "3100", 10);

const GATE_PASSPHRASE = process.env.MCP_GATE_PASSPHRASE;
if (!GATE_PASSPHRASE) {
  process.stderr.write("mcp-cowork fatal: MCP_GATE_PASSPHRASE manquant — requis pour protéger /authorize sur un serveur exposé publiquement.\n");
  process.exit(1);
}

// Un McpServer ne peut être connecté qu'à un seul transport à la fois (sinon
// "Already connected to a transport"). Chaque session Streamable HTTP a donc
// besoin de sa propre instance — createServer() réenregistre les mêmes tools
// (stateless, aucun coût réel) sur un McpServer frais à chaque session.
function ok(data) {
  const structured = data !== null && typeof data === "object" && !Array.isArray(data) ? data : { items: data };
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: structured,
  };
}

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

  return server;
}

// --- Transport HTTP (Streamable HTTP), une instance de McpServer par session ---

const transports = new Map(); // sessionId -> StreamableHTTPServerTransport

function isInitializeRequest(body) {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => m && m.method === "initialize");
}

const app = express();
// Requis derrière un tunnel (ngrok) : sans ça, express-rate-limit (utilisé par les
// routes OAuth du SDK) refuse de faire confiance au header X-Forwarded-For et throw.
app.set("trust proxy", 1);
const RESOURCE_URL = new URL("/mcp", PUBLIC_URL);

// Gate réel devant /authorize (passphrase + confirmation) — DOIT être monté avant
// mcpAuthRouter, qui sinon auto-approuve tout (voir modules/oauth.js, provider.authorize()).
app.use("/authorize", authGate({ passphrase: GATE_PASSPHRASE }));

// Monte /register, /authorize, /token, /revoke, /.well-known/oauth-authorization-server,
// et /.well-known/oauth-protected-resource/mcp (RFC 9728 — doit correspondre à la ressource /mcp).
app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(PUBLIC_URL),
    resourceServerUrl: RESOURCE_URL,
    scopesSupported: ["mcp"],
  })
);

const requireAuth = requireBearerAuth({
  verifier: oauthProvider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(RESOURCE_URL),
});

app.post("/mcp", express.json(), requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    if (!isInitializeRequest(req.body)) {
      return res.status(400).json({ error: "no valid session, expected an initialize request" });
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports.set(newSessionId, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    const server = createServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) return res.status(404).json({ error: "session not found" });
  await transport.handleRequest(req, res);
});

app.delete("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) return res.status(404).json({ error: "session not found" });
  await transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  process.stderr.write(`mcp-cowork listening on http://localhost:${PORT}/mcp\n`);
});
