const { QdrantClient } = require("@qdrant/js-client-rest");

const COLLECTION = "francis_memory";
const VECTOR_SIZE = 384;

const client = new QdrantClient({
  host: process.env.QDRANT_HOST ?? "localhost",
  port: parseInt(process.env.QDRANT_PORT ?? "6333", 10),
});

module.exports = { client, COLLECTION, VECTOR_SIZE };
