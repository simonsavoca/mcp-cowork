const { z } = require('zod');

const OSRM_BASE = 'https://router.project-osrm.org';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'mcp-cowork/1.0';

function estimateCost(distanceMeters) {
  const km = distanceMeters / 1000;
  const fuelCost = (km / 100) * 7 * 1.80;
  const co2Kg = km * 0.12;
  return { fuel_cost_eur: Math.round(fuelCost * 100) / 100, co2_kg: Math.round(co2Kg * 100) / 100 };
}

function ok(data) {
  const structured = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : { items: data };
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: structured,
  };
}

function registerOsrmTools(server) {
  server.tool(
    'osrm_geocode',
    'Convertit une adresse en coordonnées (latitude/longitude) via Nominatim/OpenStreetMap',
    { query: z.string().describe('Adresse ou lieu à rechercher, ex: "Tour Eiffel, Paris"') },
    async ({ query }) => {
      const qs = new URLSearchParams({ q: query, format: 'json', limit: '3' });
      const res = await fetch(`${NOMINATIM_BASE}/search?${qs}`, {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!res.ok) throw new Error(`Nominatim ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const results = data.map(r => ({
        label: r.display_name,
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
      }));
      return ok(results);
    }
  );

  server.tool(
    'osrm_directions',
    'Calcule un itinéraire (distance, durée, estimation coût carburant/CO2) entre deux points via OSRM',
    {
      start_lat: z.number().describe('Latitude du départ'),
      start_lng: z.number().describe('Longitude du départ'),
      end_lat: z.number().describe('Latitude de l\'arrivée'),
      end_lng: z.number().describe('Longitude de l\'arrivée'),
      profile: z.enum(['car', 'bike', 'foot']).optional().describe('Mode de transport (défaut: car)'),
    },
    async ({ start_lat, start_lng, end_lat, end_lng, profile = 'car' }) => {
      const coords = `${start_lng},${start_lat};${end_lng},${end_lat}`;
      const res = await fetch(`${OSRM_BASE}/route/v1/${profile}/${coords}?overview=false`, {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!res.ok) throw new Error(`OSRM ${res.status}: ${await res.text()}`);
      const data = await res.json();
      if (data.code !== 'Ok') throw new Error(`OSRM: ${data.code} — ${data.message || ''}`);
      const route = data.routes[0];
      const result = {
        distance_km: Math.round(route.distance / 10) / 100,
        duration_min: Math.round(route.duration / 60),
        ...(profile === 'car' ? estimateCost(route.distance) : {}),
      };
      return ok(result);
    }
  );
}

module.exports = { registerOsrmTools };
