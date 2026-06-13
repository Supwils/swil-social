/**
 * Pure vector math for the agent-observation lab.
 *
 * All embeddings come from the bge-m3 daemon, which L2-normalises every vector
 * (`normalize_embeddings=True`). Cosine similarity is therefore just the dot
 * product — we never re-normalise here.
 */

/** Cosine similarity of two (assumed L2-normalised) vectors. 0 on length mismatch / empty. */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** Cosine distance in [0, 2]. Defensive clamp absorbs float round-off. */
export function cosineDist(a: number[], b: number[]): number {
  return Math.max(0, Math.min(2, 1 - cosineSim(a, b)));
}

/** Element-wise mean of equal-length vectors. Returns null for an empty input. */
export function centroid(vectors: number[][]): number[] | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0].length;
  if (dim === 0) return null;
  const out = new Array<number>(dim).fill(0);
  let used = 0;
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
    used++;
  }
  if (used === 0) return null;
  for (let i = 0; i < dim; i++) out[i] /= used;
  return out;
}

/**
 * Mean pairwise cosine similarity across a set of vectors — the population
 * "cohesion" metric. Higher = the population writes about more similar things.
 * Returns 1 for fewer than 2 vectors (nothing to compare).
 */
export function meanPairwiseCosine(vectors: number[][]): number {
  const vecs = vectors.filter((v) => v.length > 0);
  if (vecs.length < 2) return 1;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      sum += cosineSim(vecs[i], vecs[j]);
      pairs++;
    }
  }
  return pairs > 0 ? sum / pairs : 1;
}

/**
 * Variance of pairwise cosine similarities — low variance flags an echo-chamber
 * (everything equally similar). Returns 1 (treat as diverse) for fewer than 3
 * vectors, matching the runtime's fail-open echo check.
 */
export function pairwiseVariance(vectors: number[][]): number {
  const vecs = vectors.filter((v) => v.length > 0);
  if (vecs.length < 3) return 1;
  const sims: number[] = [];
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      sims.push(cosineSim(vecs[i], vecs[j]));
    }
  }
  const mean = sims.reduce((s, x) => s + x, 0) / sims.length;
  return sims.reduce((s, x) => s + (x - mean) ** 2, 0) / sims.length;
}
