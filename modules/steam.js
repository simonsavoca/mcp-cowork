const { z } = require('zod');

const BASE = 'https://api.steampowered.com';

async function api(iface, method, version, params = {}) {
  const key = process.env.STEAM_API_KEY;
  if (!key) throw new Error('STEAM_API_KEY manquant');
  const qs = new URLSearchParams({ key, ...params }).toString();
  const res = await fetch(`${BASE}/${iface}/${method}/v${version}/?${qs}`);
  if (!res.ok) throw new Error(`Steam API ${res.status}: ${await res.text()}`);
  return res.json();
}

function steamId() {
  const id = process.env.STEAM_ID;
  if (!id) throw new Error('STEAM_ID manquant');
  return id;
}

function ok(data) {
  if (typeof data === 'string') {
    return { content: [{ type: 'text', text: data }], structuredContent: { message: data } };
  }
  const structured = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : { items: data };
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: structured,
  };
}

function registerSteamTools(server) {
  server.tool('steam_auth', 'Vérifier que les credentials Steam API sont valides', {}, async () => {
    const missing = ['STEAM_API_KEY', 'STEAM_ID'].filter(k => !process.env[k]);
    if (missing.length) {
      return ok(`Variables d'env manquantes : ${missing.join(', ')}`);
    }
    try {
      const data = await api('ISteamUser', 'GetPlayerSummaries', 2, { steamids: steamId() });
      const p = data.response.players[0];
      return ok(`Auth OK — ${p.personaname} (${p.steamid})`);
    } catch (e) {
      return ok(`Auth KO — ${e.message}`);
    }
  });

  server.tool('steam_profile', 'Profil Steam du compte (statut, avatar, dernière connexion)', {}, async () => {
    const data = await api('ISteamUser', 'GetPlayerSummaries', 2, { steamids: steamId() });
    return ok(data.response.players[0]);
  });

  server.tool('steam_level', 'Niveau Steam du compte', {}, async () => {
    const data = await api('IPlayerService', 'GetSteamLevel', 1, { steamid: steamId() });
    return ok(data.response);
  });

  server.tool(
    'steam_games',
    'Bibliothèque de jeux possédés avec temps de jeu',
    { include_free: z.boolean().optional().describe('Inclure les jeux gratuits (défaut : false)') },
    async ({ include_free = false }) => {
      const data = await api('IPlayerService', 'GetOwnedGames', 1, {
        steamid: steamId(),
        include_appinfo: 1,
        include_played_free_games: include_free ? 1 : 0,
      });
      return ok(data.response);
    }
  );

  server.tool('steam_recent', 'Jeux joués ces 2 dernières semaines', {}, async () => {
    const data = await api('IPlayerService', 'GetRecentlyPlayedGames', 1, { steamid: steamId() });
    return ok(data.response);
  });

  server.tool(
    'steam_achievements',
    'Achievements d\'un jeu',
    { appid: z.number().describe('ID Steam du jeu') },
    async ({ appid }) => {
      const data = await api('ISteamUserStats', 'GetPlayerAchievements', 1, {
        steamid: steamId(),
        appid,
      });
      return ok(data.playerstats);
    }
  );

  server.tool('steam_friends', 'Liste d\'amis Steam avec SteamID', {}, async () => {
    const data = await api('ISteamUser', 'GetFriendList', 1, {
      steamid: steamId(),
      relationship: 'friend',
    });
    return ok(data.friendslist);
  });
}

module.exports = { registerSteamTools };
