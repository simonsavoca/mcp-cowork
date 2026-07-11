// Registre générique pour les flux OAuth automatisés par redirection HTTP (ex. LinkedIn) :
// un module pose son handler ici, la route /redirect/:service délègue au bon handler.
// Volontairement PAS derrière l'authGate (voir index.js) : le navigateur de l'utilisateur
// est redirigé ici directement par le fournisseur tiers après consentement, sans cookie
// francis_gate. La protection réelle vient du state anti-CSRF + du client_secret côté serveur.

const handlers = {};

function registerOAuthRedirectHandler(service, handler) {
  handlers[service] = handler;
}

function registerOAuthRedirectRoute(app) {
  app.get("/redirect/:service", async (req, res) => {
    const handler = handlers[req.params.service];
    if (!handler) {
      return res.status(404).type("html").send("<p>Service OAuth inconnu.</p>");
    }
    await handler(req, res);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderResultPage({ success, title, message }) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f1115;
      color: #e5e7eb;
      padding: 20px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #171a21;
      border: 1px solid #262b35;
      border-radius: 8px;
      padding: 32px;
      max-width: 480px;
      text-align: center;
    }
    h1 { font-size: 20px; margin-bottom: 12px; color: ${success ? '#25d366' : '#ef5350'}; }
    p { color: #8b93a3; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

module.exports = { registerOAuthRedirectHandler, registerOAuthRedirectRoute, escapeHtml, renderResultPage };
