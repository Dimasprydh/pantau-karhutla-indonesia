(() => {
  "use strict";

  const CONFIG = window.PANTAU_CONFIG || {};
  const API_URL = String(CONFIG.apiUrl || "").replace(/\/$/, "");
  const REFRESH_MS = 15 * 60 * 1000;
  const INDONESIA_BOUNDS = [[-11.3, 94.5], [6.7, 141.5]];
  const PROVINCE_GEOJSON_URL = "https://raw.githubusercontent.com/AlfianAliM/Indonesia-GeoJSON/master/provinsi.geojson";

  const state = {
    detections: [],
    filtered: [],
    provinces: null,
    provinceLayer: null,
    markerLayer: null,
    sourceMode: "demo",
    selectedId: null
  };

  const els = {
    modeBadge: document.getElementById("modeBadge"),
    updatedAt: document.getElementById("updatedAt"),
    statTotal: document.getElementById("statTotal"),
    statRecent: document.getElementById("statRecent"),
    statHigh: document.getElementById("statHigh"),
    visibleCount: document.getElementById("visibleCount"),
    provinceFilter: document.getElementById("provinceFilter"),
    ageFilter: document.getElementById("ageFilter"),
    confidenceFilter: document.getElementById("confidenceFilter"),
    sensorFilter: document.getElementById("sensorFilter"),
    resetFilters: document.getElementById("resetFilters"),
    fitIndonesia: document.getElementById("fitIndonesia"),
    mapContext: document.getElementById("mapContext"),
    loadingState: document.getElementById("loadingState"),
    emptyDetail: document.getElementById("emptyDetail"),
    detailContent: document.getElementById("detailContent"),
    detailStatus: document.getElementById("detailStatus"),
    detailAgeBadge: document.getElementById("detailAgeBadge"),
    detailTime: document.getElementById("detailTime"),
    detailProvince: document.getElementById("detailProvince"),
    detailSatellite: document.getElementById("detailSatellite"),
    detailConfidence: document.getElementById("detailConfidence"),
    detailFrp: document.getElementById("detailFrp"),
    detailCoords: document.getElementById("detailCoords")
  };

  if (!window.L) {
    els.loadingState.textContent = "Pustaka peta gagal dimuat. Muat ulang halaman.";
    return;
  }

  const map = L.map("map", {
    zoomControl: true,
    minZoom: 3,
    maxZoom: 15,
    preferCanvas: true
  });

  map.fitBounds(INDONESIA_BOUNDS, { padding: [12, 12] });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const canvasRenderer = L.canvas({ padding: 0.5 });
  state.markerLayer = L.layerGroup().addTo(map);

  function setLoading(message, hide = false) {
    els.loadingState.textContent = message;
    els.loadingState.classList.toggle("hidden", hide);
  }

  function setMode(mode, message) {
    state.sourceMode = mode;
    els.modeBadge.className = mode === "live" ? "badge badge-live" : "badge badge-demo";
    els.modeBadge.textContent = mode === "live" ? "LIVE NASA FIRMS" : message || "MODE DEMO";
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("id-ID").format(Number(value) || 0);
  }

  function formatTime(dateValue) {
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date) + " WIB";
  }

  function hoursAgo(dateValue) {
    const diff = Date.now() - new Date(dateValue).getTime();
    if (!Number.isFinite(diff)) return 999;
    return Math.max(0, diff / 3600000);
  }

  function ageLabel(hours) {
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} menit lalu`;
    if (hours < 24) return `${Math.round(hours)} jam lalu`;
    return `${Math.round(hours / 24)} hari lalu`;
  }

  function markerColor(hours) {
    if (hours < 6) return "#ff5b4d";
    if (hours < 12) return "#ff9a3d";
    return "#f7cf58";
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

  function normalizeDetection(item, index) {
    const latitude = Number(item.latitude);
    const longitude = Number(item.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    const acquiredAt = item.acquiredAt || item.acquired_at || item.datetime || new Date().toISOString();
    const satellite = String(item.satellite || item.sensor || "Unknown");
    return {
      id: String(item.id || `${latitude.toFixed(4)}-${longitude.toFixed(4)}-${acquiredAt}-${index}`),
      latitude,
      longitude,
      acquiredAt,
      satellite,
      instrument: String(item.instrument || "VIIRS"),
      confidence: normalizeConfidence(item.confidence),
      frp: Number(item.frp),
      province: item.province || null,
      source: item.source || "NASA FIRMS"
    };
  }

  function makeDemoData() {
    const now = Date.now();
    const samples = [
      [-0.42, 109.31, 1.2, "NOAA-21", "high", 31.4],
      [-1.68, 110.23, 2.4, "NOAA-20", "nominal", 18.6],
      [-2.21, 111.72, 4.8, "Suomi-NPP", "high", 43.1],
      [-2.98, 114.41, 7.1, "NOAA-21", "nominal", 16.2],
      [-3.18, 115.21, 10.4, "NOAA-20", "high", 27.9],
      [0.48, 116.72, 3.5, "Suomi-NPP", "nominal", 12.3],
      [-0.72, 117.18, 13.6, "NOAA-21", "low", 7.2],
      [0.76, 101.48, 5.1, "NOAA-20", "high", 38.6],
      [-2.95, 104.71, 8.8, "Suomi-NPP", "nominal", 21.7],
      [-1.61, 103.61, 17.2, "NOAA-21", "high", 34.9],
      [-3.44, 137.21, 6.6, "NOAA-20", "nominal", 19.1],
      [-8.31, 118.62, 20.1, "Suomi-NPP", "low", 5.8]
    ];

    return samples.map((row, index) => ({
      id: `demo-${index + 1}`,
      latitude: row[0],
      longitude: row[1],
      acquiredAt: new Date(now - row[2] * 3600000).toISOString(),
      satellite: row[3],
      instrument: "VIIRS",
      confidence: row[4],
      frp: row[5],
      source: "Demo data"
    }));
  }

  async function loadProvinces() {
    try {
      const response = await fetch(PROVINCE_GEOJSON_URL, { cache: "force-cache" });
      if (!response.ok) throw new Error(`Province GeoJSON HTTP ${response.status}`);
      const data = await response.json();
      state.provinces = data;

      state.provinceLayer = L.geoJSON(data, {
        style: {
          color: "rgba(210,220,230,.35)",
          weight: 1,
          fillColor: "#0f1720",
          fillOpacity: 0.05
        }
      }).addTo(map);
    } catch (error) {
      console.warn("Province boundaries unavailable:", error);
      state.provinces = null;
    }
  }

  function provinceName(feature) {
    const props = feature?.properties || {};
    return String(
      props.name || props.NAME_1 || props.PROVINSI || props.Provinsi || props.Propinsi || props.province || "Tidak diketahui"
    ).trim();
  }

  function classifyProvinces() {
    if (!state.provinces || !window.turf) return;
    const features = state.provinces.features || [];

    for (const detection of state.detections) {
      if (detection.province) continue;
      const point = turf.point([detection.longitude, detection.latitude]);
      for (const feature of features) {
        try {
          if (turf.booleanPointInPolygon(point, feature)) {
            detection.province = provinceName(feature);
            break;
          }
        } catch (_) {
          // Skip malformed polygon and continue.
        }
      }
      detection.province ||= "Tidak diketahui";
    }
  }

  function populateProvinceFilter() {
    const current = els.provinceFilter.value;
    const names = [...new Set(state.detections.map(item => item.province).filter(Boolean))]
      .filter(name => name !== "Tidak diketahui")
      .sort((a, b) => a.localeCompare(b, "id"));

    els.provinceFilter.innerHTML = '<option value="all">Semua provinsi</option>';
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      els.provinceFilter.appendChild(option);
    }
    els.provinceFilter.value = names.includes(current) ? current : "all";
  }

  async function loadData() {
    setLoading(API_URL ? "Mengambil data NASA FIRMS…" : "Menampilkan data demo sampai backend dihubungkan…");

    if (!API_URL) {
      state.detections = makeDemoData();
      setMode("demo", "MODE DEMO");
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/hotspots?days=1`, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`API HTTP ${response.status}`);
      const payload = await response.json();
      const rows = Array.isArray(payload.detections) ? payload.detections : [];
      state.detections = rows.map(normalizeDetection).filter(Boolean);
      setMode("live");
    } catch (error) {
      console.error("Live API unavailable, using demo data:", error);
      state.detections = makeDemoData();
      setMode("demo", "DEMO · API OFFLINE");
    }
  }

  function filterData() {
    const province = els.provinceFilter.value;
    const age = els.ageFilter.value;
    const confidence = els.confidenceFilter.value;
    const sensor = els.sensorFilter.value;

    state.filtered = state.detections.filter(item => {
      const h = hoursAgo(item.acquiredAt);
      const matchesProvince = province === "all" || item.province === province;
      const matchesConfidence = confidence === "all" || item.confidence === confidence;
      const matchesSensor = sensor === "all" || item.satellite === sensor;
      let matchesAge = true;
      if (age === "0-6") matchesAge = h < 6;
      if (age === "6-12") matchesAge = h >= 6 && h < 12;
      if (age === "12-24") matchesAge = h >= 12 && h <= 24;
      return matchesProvince && matchesConfidence && matchesSensor && matchesAge;
    });
  }

  function renderStats() {
    const recent = state.detections.filter(item => hoursAgo(item.acquiredAt) < 6).length;
    const high = state.detections.filter(item => item.confidence === "high").length;
    els.statTotal.textContent = formatNumber(state.detections.length);
    els.statRecent.textContent = formatNumber(recent);
    els.statHigh.textContent = formatNumber(high);
    els.visibleCount.textContent = `${formatNumber(state.filtered.length)} deteksi`;
    els.updatedAt.textContent = formatTime(new Date());
  }

  function renderMarkers() {
    state.markerLayer.clearLayers();

    for (const item of state.filtered) {
      const ageHours = hoursAgo(item.acquiredAt);
      const color = markerColor(ageHours);
      const marker = L.circleMarker([item.latitude, item.longitude], {
        renderer: canvasRenderer,
        radius: ageHours < 6 ? 6 : 5,
        weight: 1,
        color,
        fillColor: color,
        fillOpacity: ageHours < 6 ? 0.82 : 0.67,
        opacity: 0.95
      });

      marker.bindTooltip(
        `<div class="map-popup"><strong>${escapeHtml(item.province || "Lokasi belum diklasifikasi")}</strong><span>${escapeHtml(ageLabel(ageHours))} · ${escapeHtml(item.satellite)}</span></div>`,
        { direction: "top", offset: [0, -5], opacity: 0.96 }
      );
      marker.on("click", () => showDetail(item));
      marker.addTo(state.markerLayer);
    }
  }

  function renderContext() {
    const parts = [];
    if (els.provinceFilter.value !== "all") parts.push(els.provinceFilter.value);
    else parts.push("Indonesia");

    const ageLabels = {
      all: "24 jam terakhir",
      "0-6": "<6 jam",
      "6-12": "6–12 jam",
      "12-24": "12–24 jam"
    };
    parts.push(ageLabels[els.ageFilter.value]);
    els.mapContext.textContent = parts.join(" · ");
  }

  function showDetail(item) {
    state.selectedId = item.id;
    const h = hoursAgo(item.acquiredAt);
    els.emptyDetail.classList.add("hidden");
    els.detailContent.classList.remove("hidden");
    els.detailStatus.textContent = h < 6 ? "Terdeteksi aktif" : "Masih dipantau";
    els.detailAgeBadge.textContent = ageLabel(h);
    els.detailTime.textContent = formatTime(item.acquiredAt);
    els.detailProvince.textContent = item.province || "Tidak diketahui";
    els.detailSatellite.textContent = `${item.satellite} · ${item.instrument}`;
    els.detailConfidence.textContent = item.confidence.charAt(0).toUpperCase() + item.confidence.slice(1);
    els.detailFrp.textContent = Number.isFinite(item.frp) ? `${item.frp.toFixed(1)} MW` : "—";
    els.detailCoords.textContent = `${item.latitude.toFixed(5)}, ${item.longitude.toFixed(5)}`;
  }

  function render() {
    filterData();
    renderStats();
    renderMarkers();
    renderContext();
    setLoading("", true);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function bindEvents() {
    [els.provinceFilter, els.ageFilter, els.confidenceFilter, els.sensorFilter].forEach(control => {
      control.addEventListener("change", render);
    });

    els.resetFilters.addEventListener("click", () => {
      els.provinceFilter.value = "all";
      els.ageFilter.value = "all";
      els.confidenceFilter.value = "all";
      els.sensorFilter.value = "all";
      render();
      map.fitBounds(INDONESIA_BOUNDS, { padding: [12, 12] });
    });

    els.fitIndonesia.addEventListener("click", () => {
      map.fitBounds(INDONESIA_BOUNDS, { padding: [12, 12] });
    });
  }

  async function refreshLiveData() {
    if (!API_URL) return;
    await loadData();
    classifyProvinces();
    populateProvinceFilter();
    state.detections.sort((a, b) => new Date(b.acquiredAt) - new Date(a.acquiredAt));
    render();
  }

  async function init() {
    bindEvents();
    await Promise.all([loadProvinces(), loadData()]);
    state.detections = state.detections.map(normalizeDetection).filter(Boolean);
    classifyProvinces();
    populateProvinceFilter();
    state.detections.sort((a, b) => new Date(b.acquiredAt) - new Date(a.acquiredAt));
    render();

    if (API_URL) {
      window.setInterval(refreshLiveData, REFRESH_MS);
    }
  }

  init().catch(error => {
    console.error(error);
    setLoading("Terjadi kesalahan saat menyiapkan dashboard. Muat ulang halaman.");
  });
})();
