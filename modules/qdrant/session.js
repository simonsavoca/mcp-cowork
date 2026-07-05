const { client, COLLECTION } = require("./client");

async function sessionList() {
  const seen = new Map();
  let offset = null;

  do {
    const params = { with_payload: ["session_id", "timestamp"], limit: 250 };
    if (offset !== null) params.offset = offset;
    const result = await client.scroll(COLLECTION, params);
    for (const point of result.points) {
      const sid = point.payload.session_id;
      if (sid && !seen.has(sid)) seen.set(sid, point.payload.timestamp);
    }
    offset = result.next_page_offset ?? null;
  } while (offset !== null);

  return Array.from(seen.entries())
    .map(([session_id, timestamp]) => ({ session_id, timestamp }))
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
}

async function sessionHistoryGet(sessionId) {
  const result = await client.scroll(COLLECTION, {
    filter: {
      must: [
        { key: "session_id", match: { value: sessionId } },
        { key: "type", match: { value: "session_history" } },
      ],
    },
    with_payload: true,
    limit: 500,
  });
  return result.points.map((p) => p.payload);
}

module.exports = { sessionList, sessionHistoryGet };
