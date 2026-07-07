const crypto = require("crypto");
const { InvalidTokenError, InvalidGrantError } = require("@modelcontextprotocol/sdk/server/auth/errors.js");

// Provider OAuth 2.1 minimal, en mémoire, pour usage mono-utilisateur.
// DCR ouverte (register.js du SDK génère déjà client_id/client_secret avant
// d'appeler registerClient — voir handlers/register.js) : ça ne donne qu'un
// client_id, pas un accès. La vraie porte est /authorize, auto-approuvée ici
// (décision : le secret de l'URL ngrok fait office de barrière).

const clients = new Map(); // client_id -> OAuthClientInformationFull
const authCodes = new Map(); // code -> { clientId, redirectUri, codeChallenge, expiresAt }
const accessTokens = new Map(); // token -> { clientId, expiresAt }
const refreshTokens = new Map(); // token -> { clientId }

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_S = 60 * 60;

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

const clientsStore = {
  getClient(clientId) {
    return clients.get(clientId);
  },
  registerClient(client) {
    clients.set(client.client_id, client);
    return client;
  },
};

const provider = {
  clientsStore,

  getStats() {
    return {
      clients: clients.size,
      accessTokens: accessTokens.size,
      refreshTokens: refreshTokens.size,
    };
  },

  async authorize(client, params, res) {
    const code = randomToken();
    authCodes.set(code, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code);
    if (params.state) redirect.searchParams.set("state", params.state);
    res.redirect(302, redirect.href);
  },

  async challengeForAuthorizationCode(client, authorizationCode) {
    const entry = authCodes.get(authorizationCode);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return entry.codeChallenge;
  },

  async exchangeAuthorizationCode(client, authorizationCode) {
    const entry = authCodes.get(authorizationCode);
    if (!entry || entry.clientId !== client.client_id || Date.now() > entry.expiresAt) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    authCodes.delete(authorizationCode); // usage unique
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const expiresAt = Date.now() + ACCESS_TOKEN_TTL_S * 1000;
    accessTokens.set(accessToken, { clientId: client.client_id, expiresAt });
    refreshTokens.set(refreshToken, { clientId: client.client_id });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
    };
  },

  async exchangeRefreshToken(client, refreshToken) {
    const entry = refreshTokens.get(refreshToken);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    const accessToken = randomToken();
    const expiresAt = Date.now() + ACCESS_TOKEN_TTL_S * 1000;
    accessTokens.set(accessToken, { clientId: client.client_id, expiresAt });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
    };
  },

  async verifyAccessToken(token) {
    const entry = accessTokens.get(token);
    if (!entry || Date.now() > entry.expiresAt) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: ["mcp"],
      expiresAt: Math.floor(entry.expiresAt / 1000),
    };
  },
};

module.exports = { provider };
