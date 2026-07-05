const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '../scripts/pronote.py');

function runPronote() {
  const pythonCmd = process.env.PYTHON_CMD;
  if (!pythonCmd) throw new Error('PYTHON_CMD manquant dans les variables d\'environnement');
  const result = spawnSync(pythonCmd, [SCRIPT], { encoding: 'utf8', timeout: 60000 });
  if (result.error) throw new Error(`pronote.py: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`pronote.py: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout.trim());
}

function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function registerPronoteTools(server) {
  server.tool('pronote_grades', 'Notes de Lise Savoca par période (Pronote / Collège de la Mauldre)', {}, async () => {
    const data = runPronote();
    return ok({ eleve: data.eleve, notes: data.notes });
  });

  server.tool('pronote_timetable', 'Emploi du temps de Lise Savoca (7 prochains jours)', {}, async () => {
    const data = runPronote();
    return ok({ eleve: data.eleve, edt: data.edt });
  });

  server.tool('pronote_absences', 'Absences de Lise Savoca par période', {}, async () => {
    const data = runPronote();
    return ok({ eleve: data.eleve, absences: data.absences });
  });

  server.tool('pronote_homework', 'Devoirs de Lise Savoca (14 prochains jours)', {}, async () => {
    const data = runPronote();
    return ok({ eleve: data.eleve, devoirs: data.devoirs });
  });

  server.tool('pronote_bulletin', 'Bulletin scolaire de Lise Savoca — moyennes par matière et par période avec moyennes de classe', {}, async () => {
    const data = runPronote();
    return ok({ eleve: data.eleve, bulletin: data.bulletin });
  });
}

module.exports = { registerPronoteTools };
