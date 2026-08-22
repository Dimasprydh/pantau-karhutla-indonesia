(() => {
  "use strict";

  const CONFIG = window.PANTAU_CONFIG || {};
  const API_URL = String(CONFIG.apiUrl || window.location.origin).replace(/\/$/, "");
  const REFRESH_MS = 15 * 60 * 1000;
  const LOOKBACK_HOURS = 24;
  const INDONESIA_BOUNDS = [[-11.3, 94.5], [6.7, 141.5]];
  const PROVINCE_GEOJSON_URL = "https://raw.githubusercontent.com/AlfianAliM/Indonesia-GeoJSON/master/provinsi.geojson";

  const state = {
    detections: [],
    filtered: [],
    provinces: null,
    provinceLayer: null,
    markerLayer: null,
    status: "loading",
    generatedAt: null
  };

  const els = Object.fromEntries([
    "modeBadge", "updatedAt", "statTotal", "statRecent", "statHigh", "visibleCount",
    "provinceFilter", "ageFilter", "confidenceFilter", "sensorFilter", "resetFilters",
    "fitIndonesia", "mapContext", "loadingState", "emptyDetail", "detailContent",
    "detailStatus", "detailAgeBadge", "detailTime", "detailProvince", "detailSatellite",
    "detailConfidence", "detailFrp", "detailCoords", "sourceSummary"
  ].map(id => [id, document.getElementById(id)]));

  if (!window.L) {
    els.loadingState.textContent = "Peta gagal dimuat. Muat ulang halaman.";
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

  const canvasRenderer = L.canvas({ padding: 0.6, tolerance: 4 });
  state.markerLayer = L.layerGroup().addTo(map);

  function setLoading(message, hide = false) {
    els.loadingState.textContent = message;
    els.loadingState.classList.toggle("hidden", hide);
  }

  function setStatus(status, message) {
    state.status = status;
    els.modeBadge.className = `badge ${status === "live" ? "badge-live" : status === "error" ? "badge-error" : "badge-neutral"}`;
    els.modeBadge.textContent = message || (status === "live" ? "NASA FIRMS NRT" : status === "error" ? "DATA TIDAK TERSEDIA" : "MEMUAT DATA");
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
    const t = new Date(dateValue).getTime();
    if (!Number.isFinite(t)) return 999;
    return Math.max(0, (Date.now() - t) / 3600000);
  }

  function ageLabel(hours) {
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} menit lalu`;
    if (hours < 24) return `${Math.round(hours)} jam lalu`;
    return `${Math.round(hours / 24)} hari lalu`;
  }

  function markerColor(hours) {
    if (hours < 6) return "#d73027";
    if (hours < 12) return "#ef8a2f";
    return "#e6b422";
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
    const acquiredAt = item.acquiredAt || item.acquired_at || item.datetime;
    if (!acquiredAt || Number.isNaN(new Date(acquiredAt).getTime())) return null;
    return {
      id: String(item.id || `${latitude}-${longitude}-${acquiredAt}-${index}`),
      latitude,
      longitude,
      acquiredAt,
      satellite: String(item.satellite || "Unknown"),
      instrument: String(item.instrument || "Unknown"),
      confidence: normalizeConfidence(item.confidence),
      frp: Number(item.frp),
      province: item.province || null,
      source: item.source || "NASA FIRMS"
    };
  }

  async function loadProvinces() {
    try {
      const response = await fetch(PROVINCE_GEOJSON_URL, { cache: "force-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.provinces = await response.json();
      state.provinceLayer = L.geoJSON(state.provinces, {
        interactive: false,
        style: { color: "rgba(50,65,80,.32)", weight: 1, fillOpacity: 0 }
      }).addTo(map);
    } catch (error) {
      console.warn("Batas provinsi tidak tersedia:", error);
    }
  }

  function provinceName(feature) {
    const props = feature?.properties || {};
    return String(props.name || props.NAME_1 || props.PROVINSI || props.Provinsi || props.Propinsi || props.province || "Tidak diketahui").trim();
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
        } catch (_) {}
      }
      detection.province ||= "Tidak diketahui";
    }
  }

  function populateFilters() {
    const currentProvince = els.provinceFilter.value;
    const provinces = [...new Set(state.detections.map(d => d.province).filter(v => v && v !== "Tidak diketahui"))].sort((a,b) => a.localeCompare(b, "id"));
    els.provinceFilter.innerHTML = '<option value="all">Semua provinsi</option>';
    provinces.forEach(name => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      els.provinceFilter.appendChild(option);
    });
    els.provinceFilter.value = provinces.includes(currentProvince) ? currentProvince : "all";

    const currentSensor = els.sensorFilter.value;
    const sensors = [...new Set(state.detections.map(d => d.satellite).filter(Boolean))].sort();
    els.sensorFilter.innerHTML = '<option value="all">Semua satelit</option>';
    sensors.forEach(name => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      els.sensorFilter.appendChild(option);
    });
    els.sensorFilter.value = sensors.includes(currentSensor) ? currentSensor : "all";
  }

  async function loadData() {
    setStatus("loading");
    setLoading("Mengambil deteksi 24 jam terakhir dari NASA FIRMS…");

    try {
      const response = await fetch(`${API_URL}/api/hotspots?hours=${LOOKBACK_HOURS}`, {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || payload.error || `API HTTP ${response.status}`);

      const rows = Array.isArray(payload.detections) ? payload.detections : [];
      state.detections = rows.map(normalizeDetection).filter(Boolean);
      state.generatedAt = payload.generatedAt || new Date().toISOString();
      setStatus("live", "NASA FIRMS NRT");
      if (els.sourceSummary) {
        const src = Array.isArray(payload.sources) ? payload.sources.join(" · ") : "VIIRS + MODIS";
        els.sourceSummary.textContent = `${src} · rolling ${LOOKBACK_HOURS} jam`;
      }
    } catch (error) {
      console.error("NASA FIRMS API gagal:", error);
      state.detections = [];
      state.generatedAt = null;
      setStatus("error", "DATA TIDAK TERSEDIA");
      setLoading(`Data live gagal dimuat: ${error.message}. Tidak ada data contoh yang ditampilkan.`);
    }
  }

  function filterData() {
    const province = els.provinceFilter.value;
    const age = els.ageFilter.value;
    const confidence = els.confidenceFilter.value;
    const sensor = els.sensorFilter.value;

    state.filtered = state.detections.filter(item => {
      const h = hoursAgo(item.acquiredAt);
      if (h > LOOKBACK_HOURS) return false;
      if (province !== "all" && item.province !== province) return false;
      if (confidence !== "all" && item.confidence !== confidence) return false;
      if (sensor !== "all" && item.satellite !== sensor) return false;
      if (age === "0-6" && !(h < 6)) return false;
      if (age === "6-12" && !(h >= 6 && h < 12)) return false;
      if (age === "12-24" && !(h >= 12 && h <= 24)) return false;
      return true;
    });
  }

  function renderStats() {
    const recent = state.detections.filter(item => hoursAgo(item.acquiredAt) < 6).length;
    const high = state.detections.filter(item => item.confidence === "high").length;
    els.statTotal.textContent = formatNumber(state.detections.length);
    els.statRecent.textContent = formatNumber(recent);
    els.statHigh.textContent = formatNumber(high);
    els.visibleCount.textContent = `${formatNumber(state.filtered.length)} deteksi`;
    els.updatedAt.textContent = state.generatedAt ? formatTime(state.generatedAt) : "—";
  }

  function renderMarkers() {
    state.markerLayer.clearLayers();
    for (const item of state.filtered) {
      const ageHours = hoursAgo(item.acquiredAt);
      const color = markerColor(ageHours);
      const marker = L.circleMarker([item.latitude, item.longitude], {
        renderer: canvasRenderer,
        radius: ageHours < 6 ? 4.2 : 3.6,
        weight: 0.7,
        color,
        fillColor: color,
        fillOpacity: 0.84,
        opacity: 0.92
      });
      marker.bindTooltip(
        `<div class="map-popup"><strong>${escapeHtml(item.province || "Lokasi belum diklasifikasi")}</strong><span>${escapeHtml(ageLabel(ageHours))} · ${escapeHtml(item.satellite)} / ${escapeHtml(item.instrument)}</span></div>`,
        { direction: "top", offset: [0, -4], opacity: 0.96 }
      );
      marker.on("click", () => showDetail(item));
      marker.addTo(state.markerLayer);
    }
  }

  function renderContext() {
    const place = els.provinceFilter.value === "all" ? "Indonesia" : els.provinceFilter.value;
    const ageLabels = { all: "24 jam terakhir", "0-6": "<6 jam", "6-12": "6–12 jam", "12-24": "12–24 jam" };
    els.mapContext.textContent = `${place} · ${ageLabels[els.ageFilter.value]}`;
  }

  function showDetail(item) {
    const h = hoursAgo(item.acquiredAt);
    els.emptyDetail.classList.add("hidden");
    els.detailContent.classList.remove("hidden");
    els.detailStatus.textContent = h < 6 ? "Deteksi terbaru" : "Deteksi hotspot";
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
    if (state.status === "live") setLoading("", true);
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
    [els.provinceFilter, els.ageFilter, els.confidenceFilter, els.sensorFilter].forEach(control => control.addEventListener("change", render));
    els.resetFilters.addEventListener("click", () => {
      els.provinceFilter.value = "all";
      els.ageFilter.value = "all";
      els.confidenceFilter.value = "all";
      els.sensorFilter.value = "all";
      render();
      map.fitBounds(INDONESIA_BOUNDS, { padding: [12, 12] });
    });
    els.fitIndonesia.addEventListener("click", () => map.fitBounds(INDONESIA_BOUNDS, { padding: [12, 12] }));
  }

  async function refreshLiveData() {
    await loadData();
    classifyProvinces();
    populateFilters();
    state.detections.sort((a, b) => new Date(b.acquiredAt) - new Date(a.acquiredAt));
    render();
  }

  async function init() {
    bindEvents();
    await Promise.all([loadProvinces(), loadData()]);
    classifyProvinces();
    populateFilters();
    state.detections.sort((a, b) => new Date(b.acquiredAt) - new Date(a.acquiredAt));
    render();
    window.setInterval(refreshLiveData, REFRESH_MS);
  }

  init().catch(error => {
    console.error(error);
    setStatus("error", "DATA TIDAK TERSEDIA");
    setLoading("Dashboard gagal disiapkan. Muat ulang halaman.");
  });
})();
