const { z } = require('zod');

/**
 * Login to NEO via ENT form authentication.
 * Returns { entUrl, cookies } for subsequent requests.
 * Manually handles cookies and redirects since fetch doesn't auto-persist cookies.
 */
async function neoLogin() {
  const entUrl = process.env.NEO_ENT_URL || 'https://ent.ecollege78.fr';
  const login = process.env.EDUCONNECT_LOGIN;
  const password = process.env.EDUCONNECT_PASSWORD;

  if (!login || !password) {
    throw new Error('Missing EDUCONNECT_LOGIN or EDUCONNECT_PASSWORD env vars');
  }

  try {
    // Step 1: POST login credentials (do NOT follow redirects automatically)
    const resp = await fetch(`${entUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: login,
        password: password,
        callBack: `${entUrl}/`,
        rememberMe: 'false'
      }),
      redirect: 'manual' // Capture redirects manually
    });

    // Collect cookies from response headers
    const setCookieHeaders = resp.headers.getSetCookie?.() ?? [];
    const cookieArray = setCookieHeaders
      .map(c => c.split(';')[0])
      .filter(c => c.trim());

    if (cookieArray.length === 0) {
      throw new Error('Login failed: no Set-Cookie headers in response');
    }

    const cookies = cookieArray.join('; ');

    if (!cookies.includes('oneSessionId')) {
      throw new Error('Login failed: no oneSessionId cookie in response');
    }

    // Step 2: Follow redirect if present (with cookies)
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get('location');
      if (location) {
        const redirectResp = await fetch(location, {
          headers: { Cookie: cookies },
          redirect: 'follow'
        });
        if (!redirectResp.ok) {
          throw new Error(`Redirect failed: HTTP ${redirectResp.status}`);
        }
      }
    }

    return { entUrl, cookies };
  } catch (e) {
    throw new Error(`Login error: ${e.message}`);
  }
}

/**
 * Make an authenticated request to NEO (GET only).
 */
async function neoFetch(entUrl, cookies, path, params = {}) {
  const url = new URL(`${entUrl}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined) {
      url.searchParams.set(k, v);
    }
  });

  const resp = await fetch(url.toString(), {
    method: 'GET',
    headers: { Cookie: cookies }
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} on ${path}`);
  }

  return resp.json();
}

/**
 * Make an authenticated request to NEO with a body (POST/PUT).
 */
async function neoRequest(entUrl, cookies, method, path, body = {}) {
  const resp = await fetch(`${entUrl}${path}`, {
    method,
    headers: { Cookie: cookies, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} on ${path}`);
  }

  const text = await resp.text();
  return text ? JSON.parse(text) : {};
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

/**
 * Register all NEO tools with the MCP server.
 */
function registerNeoTools(server) {
  // neo_auth: Verify connection to NEO
  server.tool(
    'neo_auth',
    'Verify authentication to NEO Edifice (ent.ecollege78.fr) and get user profile',
    {},
    async () => {
      try {
        const { entUrl, cookies } = await neoLogin();
        const data = await neoFetch(entUrl, cookies, '/userbook/api/person');

        return ok({ status: 'Auth OK', data });
      } catch (e) {
        return ok(`Auth KO — ${e.message}`);
      }
    }
  );

  // neo_messages: Fetch recent notifications
  server.tool(
    'neo_messages',
    'Fetch recent messages/notifications from NEO',
    {
      limit: z.number().int().min(1).max(100).default(20)
    },
    async (params) => {
      try {
        const { entUrl, cookies } = await neoLogin();
        const data = await neoFetch(entUrl, cookies, '/timeline/lastNotifications', {
          limit: params.limit
        });

        return ok(data);
      } catch (e) {
        return ok(`Messages fetch KO — ${e.message}`);
      }
    }
  );

  // neo_inbox_count: Get inbox count
  server.tool(
    'neo_inbox_count',
    'Get inbox message count (total and unread)',
    {},
    async () => {
      try {
        const { entUrl, cookies } = await neoLogin();
        const data = await neoFetch(entUrl, cookies, '/conversation/count/INBOX', {
          unread: 'false'
        });

        return ok(data);
      } catch (e) {
        return ok(`Inbox count KO — ${e.message}`);
      }
    }
  );

  // neo_homework: Fetch homework list
  server.tool(
    'neo_homework',
    'Fetch homework list from NEO',
    {},
    async () => {
      try {
        const { entUrl, cookies } = await neoLogin();
        const data = await neoFetch(entUrl, cookies, '/homeworks/list');

        return ok(data);
      } catch (e) {
        return ok(`Homework fetch KO — ${e.message}`);
      }
    }
  );

  // neo_agenda: Fetch calendar events
  server.tool(
    'neo_agenda',
    'Fetch calendar events from NEO',
    {
      start_date: z.string().optional(),
      end_date: z.string().optional()
    },
    async (params) => {
      try {
        const { entUrl, cookies } = await neoLogin();
        const data = await neoFetch(entUrl, cookies, '/calendar/events', {
          start: params.start_date,
          end: params.end_date
        });

        return ok(data);
      } catch (e) {
        return ok(`Agenda fetch KO — ${e.message}`);
      }
    }
  );

  // neo_inbox: List messages in inbox
  server.tool(
    'neo_inbox',
    'List messages from NEO inbox (conversation)',
    {
      page: z.number().int().min(0).default(0),
      unread: z.boolean().default(false)
    },
    async (params) => {
      try {
        const { entUrl, cookies } = await neoLogin();
        const data = await neoFetch(entUrl, cookies, '/conversation/list/INBOX', {
          page: params.page,
          unread: params.unread
        });

        return ok(data);
      } catch (e) {
        return ok(`Inbox list KO — ${e.message}`);
      }
    }
  );

  // neo_message_get: Fetch full message content
  server.tool(
    'neo_message_get',
    'Fetch full content of a NEO message',
    {
      id: z.string()
    },
    async (params) => {
      try {
        const { entUrl, cookies } = await neoLogin();
        const data = await neoFetch(entUrl, cookies, `/conversation/message/${params.id}`);

        return ok(data);
      } catch (e) {
        return ok(`Message fetch KO — ${e.message}`);
      }
    }
  );

  // neo_message_delete: Move message to trash (with confirmation)
  server.tool(
    'neo_message_delete',
    'Delete a NEO message (move to trash). Requires explicit confirmation.',
    {
      id: z.string(),
      confirmed: z.boolean().default(false)
    },
    async (params) => {
      try {
        if (!params.confirmed) {
          return ok(`Confirmation requise pour supprimer le message ${params.id}. Relance avec confirmed: true pour confirmer la suppression.`);
        }

        const { entUrl, cookies } = await neoLogin();
        const result = await neoRequest(entUrl, cookies, 'PUT', '/conversation/trash', {
          id: [params.id]
        });

        return ok({ deleted: true, id: params.id, result });
      } catch (e) {
        return ok(`Message delete KO — ${e.message}`);
      }
    }
  );
}

module.exports = { registerNeoTools };
