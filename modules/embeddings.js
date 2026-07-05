// Embedding JS pur (in-process), remplace l'appel Python (scripts/embed.py + fastembed).
// Même modèle que côté Python : BAAI/bge-small-en-v1.5, 384 dims, normalisé.
// Reste compatible avec la collection Qdrant "francis_memory" (384, Cosine).

let _pipelinePromise = null;

async function getPipeline() {
  if (!_pipelinePromise) {
    const { pipeline } = await import('@xenova/transformers');
    _pipelinePromise = pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
  }
  return _pipelinePromise;
}

async function embed(text) {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

module.exports = { embed };
