// Pages de confidentialité publiques (HTTP 200, sans authentification) par service.
// Requises par certaines plateformes (ex. Meta/Facebook exige une Privacy Policy URL
// pour renseigner l'app et passer en mode Live). Volontairement PAS derrière l'authGate :
// le gate ne couvre que /authorize et /status (voir index.js), donc /privacy est public.

const CONTACT_EMAIL = "simon.savoca@gmail.com";

// Clauses par service. Fallback sur "generic" si le service demandé est inconnu.
const POLICIES = {
  generic: {
    title: "Politique de confidentialité",
    intro:
      "Cette application est un outil privé, à usage strictement personnel, exploité par une seule personne (son propriétaire). Elle n'est pas destinée au public.",
  },
  facebook: {
    title: "Politique de confidentialité — Intégration Facebook / Meta",
    intro:
      "Cette intégration Facebook/Meta est un outil privé, à usage strictement personnel, utilisé par son unique propriétaire pour gérer son propre compte et les Pages qu'il administre. Elle n'est pas destinée à d'autres utilisateurs.",
  },
  linkedin: {
    title: "Politique de confidentialité — Intégration LinkedIn",
    intro:
      "Cette intégration LinkedIn est un outil privé, à usage strictement personnel, utilisé par son unique propriétaire pour consulter son propre profil LinkedIn et y publier ses propres posts. Elle n'est pas destinée à d'autres utilisateurs.",
  },
};

const COMMON_CLAUSES = [
  "Aucune donnée d'utilisateurs tiers n'est collectée, vendue, louée ou partagée.",
  "Les jetons d'accès (access tokens) sont stockés localement sur le serveur de l'application et ne servent qu'à appeler les API au nom du propriétaire.",
  "Aucune donnée n'est transmise à des tiers, hormis les appels techniques nécessaires aux API des services concernés.",
  "Les données consultées ne sont pas conservées au-delà du traitement de la requête en cours.",
  "L'application est fournie « en l'état », sans aucune garantie de disponibilité, de fiabilité ou de résultat. Le propriétaire décline toute responsabilité.",
  "Le propriétaire peut révoquer les accès à tout moment (retrait de l'application côté service, changement de mot de passe, suppression des jetons stockés).",
];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderPrivacyPage(service) {
  const key = String(service || "generic").toLowerCase();
  const policy = POLICIES[key] || POLICIES.generic;
  const updated = new Date().toISOString().slice(0, 10);

  const clauses = COMMON_CLAUSES.map((c) => `<li>${escapeHtml(c)}</li>`).join("\n        ");

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(policy.title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f1115;
      color: #e5e7eb;
      padding: 20px;
      min-height: 100vh;
      line-height: 1.6;
    }
    .container { max-width: 760px; margin: 0 auto; }
    h1 { font-size: 26px; margin-bottom: 8px; font-weight: 600; }
    .subtitle { color: #8b93a3; font-size: 14px; margin-bottom: 24px; }
    .section {
      background: #171a21;
      border: 1px solid #262b35;
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 20px;
    }
    p { margin-bottom: 12px; }
    ul { margin: 12px 0 12px 20px; }
    li { margin-bottom: 8px; }
    a { color: #64b5f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .footer {
      text-align: center;
      color: #8b93a3;
      font-size: 12px;
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #262b35;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${escapeHtml(policy.title)}</h1>
    <p class="subtitle">Dernière mise à jour : ${escapeHtml(updated)}</p>

    <div class="section">
      <p>${escapeHtml(policy.intro)}</p>
      <ul>
        ${clauses}
      </ul>
      <p>Pour toute question relative à cette politique, contactez :
        <a href="mailto:${escapeHtml(CONTACT_EMAIL)}">${escapeHtml(CONTACT_EMAIL)}</a>.
      </p>
    </div>

    <div class="footer">
      <p>Outil privé à usage personnel — aucune garantie fournie.</p>
    </div>
  </div>
</body>
</html>`;
}

function registerPrivacyRoutes(app) {
  app.get("/privacy", (req, res) => {
    res.type("html").send(renderPrivacyPage("generic"));
  });

  app.get("/privacy/:service", (req, res) => {
    res.type("html").send(renderPrivacyPage(req.params.service));
  });
}

module.exports = { registerPrivacyRoutes };
