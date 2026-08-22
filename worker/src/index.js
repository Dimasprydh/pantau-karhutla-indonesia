const SOURCES = [
  "VIIRS_NOAA20_NRT",
  "VIIRS_NOAA21_NRT",
  "VIIRS_SNPP_NRT",
  "MODIS_NRT"
];

const INDONESIA_BBOX = "94,-11,142,7";
const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const CACHE_SECONDS = 600;
const EVENT_DISTANCE_KM = 5;
const EVENT_TIME_HOURS = 18;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "pantau-karhutla-indonesia",
        firmsConfigured: Boolean(env.FIRMS_MAP_KEY),
        sources: SOURCES,
        cacheSeconds: CACHE_SECONDS,
        now: new Date().toISOString()
      });
    }

    if (url.pathname !== "/api/hotspots") {
      return env.ASSETS.fetch(request);
    }

    if (!env.FIRMS_MAP_KEY) {
      return json({
        error: "FIRMS_MAP_KEY is not configured",
        message: "NASA FIRMS credential belum tersedia pada Worker."
      }, 503);
    }

    const hours = clampInt(url.searchParams.get("hours") || "24", 1, 96);
    const dayRange = Math.min(5, Math.max(2, Math.ceil(hours / 24) + 1));
    const cacheKey = new Request(`${url.origin}/api/hotspots?hours=${hours}`, { method: "GET" });
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return withCors(cached);

    const settled = await Promise.allSettled(
      SOURCES.map(source => fetchSource(env.FIRMS_MAP_KEY, source, dayRange))
    );

    const detections = [];
    const errors = [];

    settled.forEach((result, index) => {
      if (result.status === "fulfilled") detections.push(...result.value);
      else errors.push({ source: SOURCES[index], message: result.reason?.message || "Unknown upstream error" });
    });

    if (!detections.length && errors.length === SOURCES.length) {
      return json({
        error: "All FIRMS sources failed",
        message: "Semua sumber NASA FIRMS gagal dimuat.",
        upstream: errors
      }, 502);
    }

    const now = Date.now();
    const cutoff = now - hours * 60 * 60 * 1000;
    const filtered = dedupeDetections(detections)
      .filter(item => {
        const t = new Date(item.acquiredAt).getTime();
        return Number.isFinite(t) && t >= cutoff && t <= now + 10 * 60 * 1000;
      })
      .sort((a, b) => new Date(b.acquiredAt) - new Date(a.acquiredAt));

    const events = buildFireEvents(filtered)
      .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

    const payload = {
      ok: true,
      source: "NASA FIRMS",
      mode: "near-real-time",
      generatedAt: new Date().toISOString(),
      lookbackHours: hours,
      requestedDayRange: dayRange,
      bbox: INDONESIA_BBOX,
      sources: SOURCES,
      detectionCount: filtered.length,
      eventCount: events.length,
      likelyFireCount: events.filter(e => e.classification === "very_likely_fire").length,
      verifiedFireCount: events.filter(e => e.verification === "verified").length,
      detections: filtered,
      events,
      methodology: {
        eventDistanceKm: EVENT_DISTANCE_KM,
        eventTimeHours: EVENT_TIME_HOURS,
        verification: "Satellite-derived classifications are not official ground verification."
      },
      upstreamWarnings: errors
    };

    const response = new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        ...corsHeaders(),
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=120, s-maxage=${CACHE_SECONDS}`
      }
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
};

async function fetchSource(mapKey, source, dayRange) {
  const endpoint = `${FIRMS_BASE}/${encodeURIComponent(mapKey)}/${source}/${INDONESIA_BBOX}/${dayRange}`;
  const response = await fetch(endpoint, { headers: { Accept: "text/csv" } });
  if (!response.ok) throw new Error(`${source} returned HTTP ${response.status}`);

  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<")) throw new Error(`${source} returned an invalid CSV response`);
  if (/invalid map_key|invalid source|error in processing/i.test(trimmed.slice(0, 300))) {
    throw new Error(`${source}: ${trimmed.slice(0, 160)}`);
  }

  return parseCsv(text).map((row, index) => normalizeRow(row, source, index)).filter(Boolean);
}

function normalizeRow(row, source, index) {
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const date = String(row.acq_date || "").trim();
  const rawTime = String(row.acq_time || "").trim().padStart(4, "0");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}$/.test(rawTime)) return null;

  const acquiredAt = `${date}T${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}:00Z`;
  const frp = Number(row.frp);

  return {
    id: `${source}-${date}-${rawTime}-${latitude.toFixed(5)}-${longitude.toFixed(5)}-${index}`,
    latitude,
    longitude,
    acquiredAt,
    satellite: normalizeSatellite(row.satellite, source),
    instrument: String(row.instrument || (source.startsWith("MODIS") ? "MODIS" : "VIIRS")),
    confidence: normalizeConfidence(row.confidence),
    frp: Number.isFinite(frp) ? frp : null,
    daynight: row.daynight || null,
    source: "NASA FIRMS",
    dataset: source
  };
}

function buildFireEvents(items) {
  if (!items.length) return [];

  const parent = items.map((_, i) => i);
  const rank = items.map(() => 0);
  const cellSize = 0.05;
  const grid = new Map();

  const find = i => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  const union = (a, b) => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) [ra, rb] = [rb, ra];
    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra] += 1;
  };

  const keyFor = (lat, lon) => `${Math.floor(lat / cellSize)}:${Math.floor(lon / cellSize)}`;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const gx = Math.floor(item.latitude / cellSize);
    const gy = Math.floor(item.longitude / cellSize);
    const itemTime = new Date(item.acquiredAt).getTime();

    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = grid.get(`${gx + dx}:${gy + dy}`) || [];
        for (const j of bucket) {
          const other = items[j];
          const timeDiff = Math.abs(itemTime - new Date(other.acquiredAt).getTime()) / 3600000;
          if (timeDiff > EVENT_TIME_HOURS) continue;
          if (haversineKm(item.latitude, item.longitude, other.latitude, other.longitude) <= EVENT_DISTANCE_KM) {
            union(i, j);
          }
        }
      }
    }

    const key = keyFor(item.latitude, item.longitude);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }

  const groups = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[i]);
  }

  return [...groups.values()].map((group, index) => summarizeEvent(group, index));
}

function summarizeEvent(group, index) {
  const lat = group.reduce((sum, d) => sum + d.latitude, 0) / group.length;
  const lon = group.reduce((sum, d) => sum + d.longitude, 0) / group.length;
  const times = group.map(d => new Date(d.acquiredAt).getTime()).filter(Number.isFinite);
  const firstSeenMs = Math.min(...times);
  const lastSeenMs = Math.max(...times);
  const sensors = [...new Set(group.map(d => d.satellite))];
  const instruments = [...new Set(group.map(d => d.instrument))];
  const highCount = group.filter(d => d.confidence === "high").length;
  const nominalCount = group.filter(d => d.confidence === "nominal").length;
  const frps = group.map(d => d.frp).filter(Number.isFinite);
  const maxFrp = frps.length ? Math.max(...frps) : null;
  const meanFrp = frps.length ? frps.reduce((a, b) => a + b, 0) / frps.length : null;
  const durationHours = Math.max(0, (lastSeenMs - firstSeenMs) / 3600000);

  let score = 15;
  if (group.length >= 2) score += 15;
  if (group.length >= 5) score += 10;
  if (group.length >= 10) score += 5;
  if (sensors.length >= 2) score += 20;
  if (sensors.length >= 3) score += 8;
  if (highCount >= 1) score += 15;
  if (highCount >= 3) score += 5;
  if (maxFrp !== null && maxFrp >= 20) score += 8;
  if (maxFrp !== null && maxFrp >= 50) score += 4;
  if (durationHours >= 1) score += 5;
  score = Math.min(95, score);

  let classification = "thermal_anomaly";
  let label = "Anomali panas";
  if (score >= 75) {
    classification = "very_likely_fire";
    label = "Sangat mungkin kebakaran";
  } else if (score >= 50) {
    classification = "strong_fire_indication";
    label = "Indikasi kuat kebakaran";
  }

  return {
    id: `event-${lastSeenMs}-${index}-${lat.toFixed(4)}-${lon.toFixed(4)}`,
    latitude: Number(lat.toFixed(6)),
    longitude: Number(lon.toFixed(6)),
    firstSeen: new Date(firstSeenMs).toISOString(),
    lastSeen: new Date(lastSeenMs).toISOString(),
    durationHours: Number(durationHours.toFixed(1)),
    detectionCount: group.length,
    sensors,
    instruments,
    highConfidenceCount: highCount,
    nominalConfidenceCount: nominalCount,
    maxFrp: maxFrp === null ? null : Number(maxFrp.toFixed(1)),
    meanFrp: meanFrp === null ? null : Number(meanFrp.toFixed(1)),
    score,
    classification,
    label,
    verification: "unverified",
    verifiedBy: null,
    verifiedAt: null
  };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = deg => deg * Math.PI / 180;
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function normalizeSatellite(value, source) {
  const raw = String(value || "").toUpperCase();
  if (raw.includes("N20") || source.includes("NOAA20")) return "NOAA-20";
  if (raw.includes("N21") || source.includes("NOAA21")) return "NOAA-21";
  if (raw.includes("NPP") || source.includes("SNPP")) return "Suomi-NPP";
  if (raw === "T" || raw.includes("TERRA")) return "Terra";
  if (raw === "A" || raw.includes("AQUA")) return "Aqua";
  return String(value || source);
}

function normalizeConfidence(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["h", "high"].includes(raw)) return "high";
  if (["n", "nominal", "medium"].includes(raw)) return "nominal";
  if (["l", "low"].includes(raw)) return "low";
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    if (numeric >= 80) return "high";
    if (numeric >= 30) return "nominal";
    return "low";
  }
  return "nominal";
}

function dedupeDetections(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = [item.dataset, item.satellite, item.acquiredAt, item.latitude.toFixed(4), item.longitude.toFixed(4)].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(header => header.trim());
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => { row[header] = values[index] ?? ""; });
    return row;
  });
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else current += char;
  }
  values.push(current);
  return values;
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type, Accept"
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders()).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
