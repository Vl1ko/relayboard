import "dotenv/config";

const durationMs = Number(process.env.LOAD_DURATION_MS || 60_000);
const concurrency = Number(process.env.LOAD_CONCURRENCY || 50);
const base = "http://localhost:3001";
const paths = ["/api/dashboard", "/api/integrations", "/api/destinations", "/api/posts"];
const latencies = [];
const statuses = new Map();
let errors = 0;
let requests = 0;
const startedAt = performance.now();
const deadline = startedAt + durationMs;

async function virtualUser(index) {
  while (performance.now() < deadline) {
    const before = performance.now();
    try {
      const response = await fetch(`${base}${paths[(requests + index) % paths.length]}`, { headers: { "x-admin-key": process.env.ADMIN_API_KEY } });
      await response.arrayBuffer();
      statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
      if (!response.ok) errors += 1;
    } catch { errors += 1; }
    latencies.push(performance.now() - before);
    requests += 1;
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, index) => virtualUser(index)));
latencies.sort((a, b) => a - b);
const percentile = (value) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * value))] || 0;
const elapsedSeconds = (performance.now() - startedAt) / 1000;
console.log(JSON.stringify({
  durationSeconds: Number(elapsedSeconds.toFixed(2)), concurrency, requests,
  requestsPerSecond: Number((requests / elapsedSeconds).toFixed(1)),
  p50Ms: Number(percentile(0.5).toFixed(2)), p95Ms: Number(percentile(0.95).toFixed(2)), p99Ms: Number(percentile(0.99).toFixed(2)),
  maxMs: Number((latencies.at(-1) || 0).toFixed(2)), errors, errorRate: Number((errors / Math.max(1, requests)).toFixed(6)),
  statuses: Object.fromEntries(statuses),
}));
