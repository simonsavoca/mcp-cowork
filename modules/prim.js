const { z } = require('zod');

const NAVITIA_BASE = 'https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia';
const SIRI_BASE = 'https://prim.iledefrance-mobilites.fr/marketplace';

function apiKey() {
  const key = process.env.PRIM_API_KEY;
  if (!key) throw new Error('PRIM_API_KEY manquant');
  return key;
}

async function api(url) {
  const res = await fetch(url, {
    headers: { apikey: apiKey(), accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`PRIM API ${res.status}: ${await res.text()}`);
  return res.json();
}

function toMonitoringRef(navitiaId) {
  const m = /^stop_area:IDFM:(.+)$/.exec(navitiaId || '');
  return m ? `STIF:StopArea:SP:${m[1]}:` : null;
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

function registerPrimTools(server) {
  server.tool('prim_auth', 'Vérifier que la clé API PRIM (Île-de-France Mobilités) est valide', {}, async () => {
    if (!process.env.PRIM_API_KEY) {
      return ok('Variable PRIM_API_KEY manquante');
    }
    try {
      await api(`${NAVITIA_BASE}/places?q=Paris&type[]=stop_area`);
      return ok('Auth OK');
    } catch (e) {
      return ok(`Auth KO — ${e.message}`);
    }
  });

  server.tool(
    'prim_search_stop',
    "Recherche une gare/station/arrêt par nom (retourne son id stop_area et son monitoring_ref utilisable pour prim_departures)",
    { query: z.string().describe('Nom du lieu à rechercher, ex: "Aulnay-sur-Mauldre" ou "Gare de Lyon"') },
    async ({ query }) => {
      const url = `${NAVITIA_BASE}/places?q=${encodeURIComponent(query)}&type[]=stop_area`;
      const data = await api(url);
      const results = (data.places || []).map(p => {
        const id = p.stop_area?.id || p.id;
        return {
          name: p.name,
          id,
          monitoring_ref: toMonitoringRef(id),
        };
      });
      return ok(results);
    }
  );

  server.tool(
    'prim_search_line',
    'Recherche une ligne de transport par nom (métro, RER, tram, bus, ex: "RER A", "Ligne J", "Metro 4") — retourne son id ligne utilisable pour prim_disruptions',
    { query: z.string().describe('Nom ou numéro de la ligne à rechercher, ex: "RER A", "Ligne J", "Metro 4", "Bus 38"') },
    async ({ query }) => {
      const url = `${NAVITIA_BASE}/pt_objects?q=${encodeURIComponent(query)}&type[]=line`;
      const data = await api(url);
      const results = (data.pt_objects || []).map(o => ({
        name: o.name,
        id: o.line?.id || o.id,
        network: o.line?.network?.name,
        mode: o.line?.commercial_mode?.name,
        code: o.line?.code,
      }));
      return ok(results);
    }
  );

  server.tool(
    'prim_departures',
    "Prochains passages temps réel à un arrêt (format SIRI, ex: MonitoringRef 'STIF:StopArea:SP:463641:')",
    { monitoring_ref: z.string().describe("Référence SIRI de l'arrêt, format STIF:StopArea:SP:<code>: (ou id Navitia stop_area:IDFM:...)") },
    async ({ monitoring_ref }) => {
      const ref = monitoring_ref.startsWith('stop_area:IDFM:')
        ? toMonitoringRef(monitoring_ref)
        : monitoring_ref;
      const url = `${SIRI_BASE}/stop-monitoring?MonitoringRef=${encodeURIComponent(ref)}`;
      const data = await api(url);
      const visits = data?.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]?.MonitoredStopVisit || [];
      const results = visits.map(v => {
        const j = v.MonitoredVehicleJourney;
        return {
          line: j?.PublishedLineName?.[0]?.value,
          destination: j?.DestinationName?.[0]?.value,
          expected: j?.MonitoredCall?.ExpectedDepartureTime || j?.MonitoredCall?.ExpectedArrivalTime,
        };
      });
      return ok(results);
    }
  );

  server.tool(
    'prim_line_routes',
    "Liste les itinéraires (branches) d'une ligne — une ligne peut desservir des chemins différents selon les trains (ex: Ligne J Paris St-Lazare/Mantes-la-Jolie via Conflans ou via Houilles-Carrières-sur-Seine), utilise l'id de ligne obtenu via prim_search_line",
    { line_id: z.string().describe('id de la ligne, ex: line:IDFM:C01742 (voir prim_search_line)') },
    async ({ line_id }) => {
      const url = `${NAVITIA_BASE}/lines/${encodeURIComponent(line_id)}/routes?count=100`;
      const data = await api(url);
      const results = (data.routes || []).map(r => ({
        route_id: r.id,
        name: r.name,
        direction: r.direction?.name,
      }));
      return ok(results);
    }
  );

  server.tool(
    'prim_line_stops',
    "Liste les arrêts desservis par une ligne, regroupés et ordonnés par itinéraire/branche (car une même ligne peut avoir des chemins et arrêts différents selon la branche — voir prim_line_routes). Utilise l'id de ligne obtenu via prim_search_line, ou limite à un route_id précis (voir prim_line_routes)",
    {
      line_id: z.string().describe('id de la ligne, ex: line:IDFM:C01742 (voir prim_search_line)'),
      route_id: z.string().optional().describe("id d'un itinéraire précis (voir prim_line_routes) pour ne lister que cette branche"),
    },
    async ({ line_id, route_id }) => {
      let routes;
      if (route_id) {
        routes = [{ route_id, name: null, direction: null }];
      } else {
        const routesData = await api(`${NAVITIA_BASE}/lines/${encodeURIComponent(line_id)}/routes?count=100`);
        routes = (routesData.routes || []).map(r => ({ route_id: r.id, name: r.name, direction: r.direction?.name }));
      }

      const results = [];
      for (const route of routes) {
        const data = await api(`${NAVITIA_BASE}/routes/${encodeURIComponent(route.route_id)}/stop_points?count=1000&depth=1`);
        const stops = [];
        let lastAreaId = null;
        for (const sp of data.stop_points || []) {
          const areaId = sp.stop_area?.id || null;
          if (areaId && areaId === lastAreaId) continue;
          stops.push({
            name: sp.stop_area?.name || sp.name,
            stop_area_id: areaId,
            monitoring_ref: toMonitoringRef(areaId),
          });
          lastAreaId = areaId;
        }
        results.push({ route_id: route.route_id, route_name: route.name, direction: route.direction, stops });
      }
      return ok(results);
    }
  );

  server.tool(
    'prim_disruptions',
    'Liste les perturbations de trafic en cours sur le réseau IDFM (RATP, Transilien, RER, Tram, Bus)',
    { line_id: z.string().optional().describe('Filtrer sur une ligne précise, ex: line:IDFM:C01742 (optionnel)') },
    async ({ line_id }) => {
      const url = line_id
        ? `${NAVITIA_BASE}/lines/${encodeURIComponent(line_id)}/line_reports`
        : `${NAVITIA_BASE}/line_reports`;
      const data = await api(url);
      const disruptions = (data.disruptions || []).map(d => ({
        id: d.id,
        severity: d.severity?.name,
        cause: d.cause,
        message: d.messages?.[0]?.text,
        period: d.application_periods?.[0],
      }));
      return ok(disruptions);
    }
  );
}

module.exports = { registerPrimTools };
