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

module.exports = { registerOAuthRedirectHandler, registerOAuthRedirectRoute };
