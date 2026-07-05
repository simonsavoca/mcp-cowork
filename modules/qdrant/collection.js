const { client, COLLECTION, VECTOR_SIZE } = require("./client");

async function collectionInit() {
  const { collections } = await client.getCollections();
  const exists = collections.some((c) => c.name === COLLECTION);
  if (!exists) {
    await client.createCollection(COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
  }

  for (const field of ["type", "session_id", "status", "priority"]) {
    try {
      await client.createPayloadIndex(COLLECTION, {
        field_name: field,
        field_schema: "keyword",
      });
    } catch (err) {
      if (!err.message.includes("already exists")) throw err;
    }
  }

  return { created: exists ? false : true, existing: true };
}

module.exports = { collectionInit };
