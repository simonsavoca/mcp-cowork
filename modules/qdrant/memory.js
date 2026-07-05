const { client, COLLECTION } = require("./client");

async function memorySearch(vector, filter, limit = 5) {
  const params = { vector, limit, with_payload: true };
  if (filter) params.filter = filter;
  return client.search(COLLECTION, params);
}

async function memoryStore(id, vector, payload) {
  await client.upsert(COLLECTION, {
    points: [{ id, vector, payload }],
  });
}

async function memoryUpdate(id, payload) {
  await client.setPayload(COLLECTION, { payload, points: [id] });
}

async function memoryDelete(id) {
  await client.delete(COLLECTION, { points: [id] });
}

module.exports = { memorySearch, memoryStore, memoryUpdate, memoryDelete };
