const { z } = require('zod');
const { execSync } = require('child_process');
const http = require('http');

const IPC_HOST = '127.0.0.1';
const IPC_PORT = 3099;

function ipcRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: IPC_HOST, port: IPC_PORT, path, method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        }, res => {
            let out = '';
            res.on('data', d => out += d);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(out); } catch (e) {
                    return reject(new Error(`Daemon response malformé (${path}): ${e.message}`));
                }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', e => reject(new Error(`Impossible de joindre le daemon WhatsApp sur ${IPC_HOST}:${IPC_PORT} — vérifier qu'il tourne (pm2 status whatsapp-daemon). Détail : ${e.message}`)));
        if (data) req.write(data);
        req.end();
    });
}

const ipcGet = (path) => ipcRequest('GET', path);
const ipcPost = (path, body) => ipcRequest('POST', path, body);

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

function registerWhatsAppTools(server) {
    server.tool(
        'whatsapp_recent',
        'Lire les derniers messages WhatsApp capturés par le daemon',
        {
            limit: z.number().optional().describe('Nombre de messages à retourner (défaut : 20)'),
            filter: z.string().optional().describe('Filtrer par mot-clé dans le nom du chat ou le texte (insensible à la casse)'),
        },
        async ({ limit = 20, filter }) => {
            const qs = new URLSearchParams({ limit: String(limit), ...(filter ? { filter } : {}) });
            const { status, body } = await ipcGet(`/messages/recent?${qs}`);
            if (status !== 200) return ok(`Erreur : ${body.error}`);
            return ok(body.messages);
        }
    );

    server.tool(
        'whatsapp_unread',
        'Messages WhatsApp reçus depuis la dernière lecture (basé sur la base du daemon). ' +
        'Passer les "id" des messages retournés à whatsapp_mark_read pour ne marquer comme lus ' +
        'que les messages effectivement montrés ici.',
        {},
        async () => {
            const { status, body } = await ipcGet('/messages/unread');
            if (status !== 200) return ok(`Erreur : ${body.error}`);
            if (!body.messages.length) return ok('Aucun message non lu.');
            return ok(body.messages);
        }
    );

    server.tool(
        'whatsapp_send',
        'Envoyer un message WhatsApp à un contact ou un groupe, recherché par nom (ou sous-chaîne)',
        {
            query: z.string().describe('Nom du contact ou du groupe (ou sous-chaîne) — ex: "Virginie" ou "Famille"'),
            message: z.string().describe('Texte du message à envoyer'),
        },
        async ({ query, message }) => {
            const { status, body } = await ipcPost('/send', { query, message });
            if (status === 409) {
                const list = body.matches.map(m => `- ${m.name}${m.isGroup ? ' (groupe)' : ''} — ${m.jid}`).join('\n');
                return ok(`Plusieurs correspondances pour "${query}", précise :\n${list}`);
            }
            if (status !== 200) return ok(`Erreur : ${body.error}`);
            return ok(body.msg);
        }
    );

    server.tool(
        'whatsapp_auth',
        'Vérifier ou réinitialiser la session WhatsApp (auth + daemon PM2)',
        {
            action: z.enum(['status', 'reset']).describe('"status" : état de la session et du daemon — "reset" : supprimer la session et redémarrer pour re-scanner le QR'),
        },
        async ({ action }) => {
            if (action === 'status') {
                let pm2Status = 'inconnu';
                try {
                    const raw = execSync('pm2 jlist', { encoding: 'utf8' });
                    const procs = JSON.parse(raw);
                    const proc = procs.find(p => p.name === 'whatsapp-daemon');
                    pm2Status = proc ? `${proc.pm2_env.status} (pid ${proc.pid}, restarts: ${proc.pm2_env.restart_time})` : 'non trouvé dans PM2';
                } catch (e) {
                    pm2Status = `erreur PM2 : ${e.message}`;
                }

                try {
                    const { status, body } = await ipcGet('/auth/status');
                    if (status !== 200) throw new Error(body.error || `HTTP ${status}`);
                    const report = [
                        `Daemon PM2      : ${pm2Status}`,
                        `Connexion WA    : ${body.connectionState}`,
                        `Compte          : ${body.user ? `${body.user.name} (${body.user.id})` : 'non connecté'}`,
                        `Messages en base: ${body.messageCount}`,
                    ].join('\n');
                    return ok(report);
                } catch (e) {
                    return ok(`Daemon PM2      : ${pm2Status}\nErreur IPC daemon : ${e.message}`);
                }
            }

            if (action === 'reset') {
                const { status, body } = await ipcPost('/auth/reset');
                if (status !== 200) return ok(`Erreur lors du reset : ${body.error}`);
                return ok('Session supprimée, nouveau QR en cours de génération.\nOuvrir http://127.0.0.1:3099/ pour scanner le QR (WhatsApp mobile → Appareils liés).');
            }
        }
    );

    server.tool(
        'whatsapp_mark_read',
        'Marquer des messages WhatsApp comme lus (ticks bleus) — visible sur tous les appareils, irréversible. ' +
        'Passer "ids" avec les identifiants renvoyés par whatsapp_unread pour ne marquer que les messages ' +
        'réellement montrés (sinon, "upTo" marque tout message non lu jusqu\'à ce timestamp/maintenant).',
        {
            confirm: z.boolean().describe('Doit être true pour confirmer — l\'action est visible sur WhatsApp mobile'),
            ids: z.array(z.number()).optional().describe('IDs des messages (renvoyés par whatsapp_unread) à marquer comme lus'),
            upTo: z.string().optional().describe('Timestamp ISO borne haute — omis = tous les messages non lus jusqu\'à maintenant.'),
        },
        async ({ confirm, ids, upTo }) => {
            if (!confirm) {
                return ok('Action annulée — passer confirm: true pour confirmer.');
            }
            const { status, body } = await ipcPost('/messages/read', ids?.length ? { ids } : { upTo });
            if (status !== 200) return ok(`Erreur IPC daemon : ${body.error}`);
            return ok(`${body.count} message(s) marqué(s) comme lus dans WhatsApp.`);
        }
    );

    server.tool(
        'whatsapp_join_group',
        'Rejoindre un groupe WhatsApp via un lien d\'invitation',
        {
            inviteLink: z.string().describe('URL d\'invitation (https://chat.whatsapp.com/CODE)'),
        },
        async ({ inviteLink }) => {
            const { status, body } = await ipcPost('/join-group', { inviteLink });
            if (status !== 200) {
                if (body.errorType === 'already-member') return ok('Déjà membre du groupe.');
                if (body.errorType === 'pending-approval') return ok("Demande envoyée — en attente d'approbation par un admin.");
                return ok(`Erreur : ${body.error}`);
            }
            return ok(`Groupe rejoint : ${body.jid}`);
        }
    );
}

module.exports = { registerWhatsAppTools };
