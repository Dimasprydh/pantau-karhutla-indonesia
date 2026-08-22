const SOURCES = [
  "VIIRS_NOAA20_NRT",
  "VIIRS_NOAA21_NRT",
  "VIIRS_SNPP_NRT"
];

const INDONESIA_BBOX = "94,-11,142,7";
const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const CACHE_SECONDS = 600;

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
        service: "pantau-karhutla-api",
        firmsConfigured: Boolean(env.FIRMS_MAP_KEY),
        sources: SOURCES,
        cacheSeconds: CACHE_SECONDS
      });
    }

    if (url.pathname !== "/api/hotspots") {
      return json({
        ok: true,
        message: "Pantau Karhutla Indonesia API",
        endpoints: ["/health", "/api/hotspots?days=1"]
      });
    }

    if (!env.FIRMS_MAP_KEY) {
      return json({
        error: "FIRMS_MAP_KEY is not configured",
        hint: "Run: wrangler secret put FIRMS_MAP_KEY"
      }, 503);
    }

    const days = clampInt(url.searchParams.get("days") || "1", 1, 5);
    const cacheKey = new Request(`${url.origin}/api/hotspots?days=${days}`, { method: "GET" });
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return withCors(cached);

    try {
      const settled = await Promise.allSettled(
        SOURCES.map(source => fetchSource(env.FIRMS_MAP_KEY, source, days))
      );

      const detections = [];
      const errors = [];

      settled.forEach((result, index) => {
        if (result.status === "fulfilled") {
          detections.push(...result.value);
        } else {
          errors.push({ source: SOURCES[index], message: result.reason?.message || "Unknown upstream error" });
        }
      });

      if (!detections.length && errors.length === SOURCES.length) {
        return json({ error: "All FIRMS sources failed", upstream: errors }, 502);
      }

      const deduped = dedupeDetections(detections)
        .sort((a, b) => new Date(b.acquiredAt) - new Date(a.acquiredAt));

      const payload = {
        ok: true,
        source: "NASA FIRMS",
        mode: "near-real-time",
        generatedAt: new Date().toISOString(),
        days,
        bbox: INDONESIA_BBOX,
        count: deduped.length,
        detections: deduped,
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
    } catch (error) {
      return json({ error: "Unable to load FIRMS data", message: error.message }, 502);
    }
  }
};

async function fetchSource(mapKey, source, days) {
  const endpoint = `${FIRMS_BASE}/${encodeURIComponent(mapKey)}/${source}/${INDONESIA_BBOX}/${days}`;
  const response = await fetch(endpoint, {
    headers: {
      Accept: "text/csv",
      "User-Agent": "Pantau-Karhutla-Indonesia/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`${source} returned HTTP ${response.status}`);
  }

  const text = await response.text();
  if (!text.trim() || text.trim().startsWith("<")) {
    throw new Error(`${source} returned an invalid CSV response`);
  }

  const rows = parseCsv(text);
  return rows.map((row, index) => normalizeRow(row, source, index)).filter(Boolean);
}

function normalizeRow(row, source, index) {
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const date = String(row.acq_date || "").trim();
  const rawTime = String(row.acq_time || "").trim().padStart(4, "0");
  const hour = rawTime.slice(0, 2);
  const minute = rawTime.slice(2, 4);
  const acquiredAt = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? `${date}T${hour}:${minute}:00Z`
    : new Date().toISOString();

  const satellite = normalizeSatellite(row.satellite, source);
  const confidence = normalizeConfidence(row.confidence);
  const frp = Number(row.frp);

  return {
    id: `${source}-${date}-${rawTime}-${latitude.toFixed(5)}-${longitude.toFixed(5)}-${index}`,
    latitude,
    longitude,
    acquiredAt,
    satellite,
    instrument: String(row.instrument || "VIIRS"),
    confidence,
    frp: Number.isFinite(frp) ? frp : null,
    daynight: row.daynight || null,
    source: "NASA FIRMS"
  };
}

function normalizeSatellite(value, source) {
  const raw = String(value || "").toUpperCase();
  if (raw.includes("N20") || source.includes("NOAA20")) return "NOAA-20";
  if (raw.includes("N21") || source.includes("NOAA21")) return "NOAA-21";
  if (raw.includes("NPP") || source.includes("SNPP")) return "Suomi-NPP";
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
    const key = [
      item.satellite,
      item.acquiredAt,
      item.latitude.toFixed(4),
      item.longitude.toFixed(4)
    ].join("|");

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
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
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
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
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
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
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
