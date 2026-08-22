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
    events: [],
    filteredDetections: [],
    filteredEvents: [],
    provinces: null,
    provinceLayer: null,
    rawLayer: null,
    eventLayer: null,
    status: "loading",
    generatedAt: null
  };

  const ids = [
    "modeBadge", "updatedAt", "statDetections", "statEvents", "statLikely", "statVerified",
    "visibleCount", "provinceFilter", "statusFilter", "ageFilter", "sensorFilter", "resetFilters",
    "fitIndonesia", "mapContext", "loadingState", "emptyDetail", "detailContent", "detailStatus",
    "detailAgeBadge", "detailFirstSeen", "detailLastSeen", "detailProvince", "detailSensors",
    "detailDetections", "detailFrp", "detailCoords", "detailScore", "detailVerification", "sourceSummary"
  ];
  const els = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));

  if (!window.L) {
    els.loadingState.textContent = "Peta gagal dimuat. Muat ulang halaman.";
    return;
  }

  const map = L.map("map", { zoomControl: true, minZoom: 3, maxZoom: 15, preferCanvas: true });
  map.fitBounds(INDONESIA_BOUNDS, { padding: [12, 12] });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const canvasRenderer = L.canvas({ padding: 0.6, tolerance: 4 });
  state.rawLayer = L.layerGroup().addTo(map);
  state.eventLayer = L.layerGroup().addTo(map);

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

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).format(date) + " WIB";
  }

  function hoursAgo(value) {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 3600000) : 999;
  }

  function ageLabel(hours) {
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} menit lalu`;
    if (hours < 24) return `${Math.round(hours)} jam lalu`;
    return `${Math.round(hours / 24)} hari lalu`;
  }

  function eventColor(event) {
    if (event.verification === "verified") return "#2d9b67";
    if (event.classification === "very_likely_fire") return "#c9362b";
    if (event.classification === "strong_fire_indication") return "#e47f2a";
    return "#d3aa24";
  }

  function eventStatusLabel(event) {
    if (event.verification === "verified") return "Kebakaran terverifikasi";
    return event.label || "Anomali panas";
  }

  function normalizeDetection(item, index) {
    const latitude = Number(item.latitude);
    const longitude = Number(item.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (!item.acquiredAt || Number.isNaN(new Date(item.acquiredAt).getTime())) return null;
    return {
      id: String(item.id || `d-${index}`), latitude, longitude, acquiredAt: item.acquiredAt,
      satellite: String(item.satellite || "Unknown"), instrument: String(item.instrument || "Unknown"),
      confidence: String(item.confidence || "nominal"), frp: Number(item.frp), province: item.province || null
    };
  }

  function normalizeEvent(item, index) {
    const latitude = Number(item.latitude);
    const longitude = Number(item.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return {
      id: String(item.id || `e-${index}`), latitude, longitude,
      firstSeen: item.firstSeen, lastSeen: item.lastSeen,
      durationHours: Number(item.durationHours) || 0,
      detectionCount: Number(item.detectionCount) || 0,
      sensors: Array.isArray(item.sensors) ? item.sensors : [],
      instruments: Array.isArray(item.instruments) ? item.instruments : [],
      highConfidenceCount: Number(item.highConfidenceCount) || 0,
      maxFrp: Number.isFinite(Number(item.maxFrp)) ? Number(item.maxFrp) : null,
      meanFrp: Number.isFinite(Number(item.meanFrp)) ? Number(item.meanFrp) : null,
      score: Number(item.score) || 0,
      classification: String(item.classification || "thermal_anomaly"),
      label: String(item.label || "Anomali panas"),
      verification: String(item.verification || "unverified"),
      verifiedBy: item.verifiedBy || null,
      province: item.province || null
    };
  }

  async function loadProvinces() {
    try {
      const response = await fetch(PROVINCE_GEOJSON_URL, { cache: "force-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.provinces = await response.json();
      state.provinceLayer = L.geoJSON(state.provinces, {
        interactive: false,
        style: { color: "rgba(45,58,70,.30)", weight: 1, fillOpacity: 0 }
      }).addTo(map);
    } catch (error) {
      console.warn("Batas provinsi tidak tersedia:", error);
    }
  }

  function provinceName(feature) {
    const p = feature?.properties || {};
    return String(p.name || p.NAME_1 || p.PROVINSI || p.Provinsi || p.Propinsi || p.province || "Tidak diketahui").trim();
  }

  function locateProvince(latitude, longitude) {
    if (!state.provinces || !window.turf) return "Tidak diketahui";
    const point = turf.point([longitude, latitude]);
    for (const feature of state.provinces.features || []) {
      try {
        if (turf.booleanPointInPolygon(point, feature)) return provinceName(feature);
      } catch (_) {}
    }
    return "Tidak diketahui";
  }

  function classifyLocations() {
    state.detections.forEach(d => { if (!d.province) d.province = locateProvince(d.latitude, d.longitude); });
    state.events.forEach(e => { if (!e.province) e.province = locateProvince(e.latitude, e.longitude); });
  }

  function populateFilters() {
    const currentProvince = els.provinceFilter.value;
    const names = [...new Set(state.events.map(e => e.province).filter(v => v && v !== "Tidak diketahui"))].sort((a, b) => a.localeCompare(b, "id"));
    els.provinceFilter.innerHTML = '<option value="all">Semua provinsi</option>';
    names.forEach(name => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      els.provinceFilter.appendChild(option);
    });
    els.provinceFilter.value = names.includes(currentProvince) ? currentProvince : "all";

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
    setLoading("Mengambil data satelit dan menyusun kejadian kebakaran…");
    try {
      const response = await fetch(`${API_URL}/api/hotspots?hours=${LOOKBACK_HOURS}`, { headers: { Accept: "application/json" }, cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || payload.error || `API HTTP ${response.status}`);

      state.detections = (Array.isArray(payload.detections) ? payload.detections : []).map(normalizeDetection).filter(Boolean);
      state.events = (Array.isArray(payload.events) ? payload.events : []).map(normalizeEvent).filter(Boolean);
      state.generatedAt = payload.generatedAt || new Date().toISOString();
      setStatus("live", "NASA FIRMS NRT");
      if (els.sourceSummary) els.sourceSummary.textContent = `${state.detections.length} deteksi · ${state.events.length} kejadian · rolling ${LOOKBACK_HOURS} jam`;
    } catch (error) {
      console.error("API live gagal:", error);
      state.detections = [];
      state.events = [];
      state.generatedAt = null;
      setStatus("error", "DATA TIDAK TERSEDIA");
      setLoading(`Data live gagal dimuat: ${error.message}.`);
    }
  }

  function eventMatchesStatus(event, value) {
    if (value === "all") return true;
    if (value === "verified") return event.verification === "verified";
    return event.classification === value;
  }

  function filterData() {
    const province = els.provinceFilter.value;
    const status = els.statusFilter.value;
    const age = els.ageFilter.value;
    const sensor = els.sensorFilter.value;

    state.filteredEvents = state.events.filter(event => {
      const h = hoursAgo(event.lastSeen);
      if (province !== "all" && event.province !== province) return false;
      if (!eventMatchesStatus(event, status)) return false;
      if (age === "0-6" && !(h < 6)) return false;
      if (age === "6-12" && !(h >= 6 && h < 12)) return false;
      if (age === "12-24" && !(h >= 12 && h <= 24)) return false;
      if (sensor !== "all" && !event.sensors.includes(sensor)) return false;
      return true;
    });

    const visibleProvinces = new Set(state.filteredEvents.map(e => e.province));
    state.filteredDetections = state.detections.filter(d => {
      if (province !== "all" && d.province !== province) return false;
      if (sensor !== "all" && d.satellite !== sensor) return false;
      if (province === "all" && status === "all" && age === "all") return true;
      return visibleProvinces.has(d.province);
    });
  }

  function renderStats() {
    els.statDetections.textContent = formatNumber(state.detections.length);
    els.statEvents.textContent = formatNumber(state.events.length);
    els.statLikely.textContent = formatNumber(state.events.filter(e => e.classification === "very_likely_fire").length);
    els.statVerified.textContent = formatNumber(state.events.filter(e => e.verification === "verified").length);
    els.visibleCount.textContent = `${formatNumber(state.filteredEvents.length)} kejadian · ${formatNumber(state.filteredDetections.length)} deteksi`;
    els.updatedAt.textContent = state.generatedAt ? formatTime(state.generatedAt) : "—";
  }

  function renderRawDetections() {
    state.rawLayer.clearLayers();
    for (const d of state.filteredDetections) {
      const h = hoursAgo(d.acquiredAt);
      const color = h < 6 ? "#d94841" : h < 12 ? "#e89a3c" : "#d3aa24";
      L.circleMarker([d.latitude, d.longitude], {
        renderer: canvasRenderer, radius: 2.1, weight: 0, fillColor: color, fillOpacity: 0.55, interactive: false
      }).addTo(state.rawLayer);
    }
  }

  function renderEvents() {
    state.eventLayer.clearLayers();
    for (const event of state.filteredEvents) {
      const color = eventColor(event);
      const radius = Math.min(14, 6 + Math.log2(Math.max(1, event.detectionCount)) * 1.6);
      const marker = L.circleMarker([event.latitude, event.longitude], {
        renderer: canvasRenderer,
        radius,
        weight: 2,
        color,
        fillColor: color,
        fillOpacity: 0.18,
        opacity: 0.98
      });
      marker.bindTooltip(
        `<div class="map-popup"><strong>${escapeHtml(eventStatusLabel(event))}</strong><span>${escapeHtml(event.province || "Lokasi belum diklasifikasi")} · ${formatNumber(event.detectionCount)} deteksi · skor ${event.score}/100</span></div>`,
        { direction: "top", offset: [0, -5], opacity: 0.97 }
      );
      marker.on("click", () => showEventDetail(event));
      marker.addTo(state.eventLayer);
    }
  }

  function showEventDetail(event) {
    const h = hoursAgo(event.lastSeen);
    els.emptyDetail.classList.add("hidden");
    els.detailContent.classList.remove("hidden");
    els.detailStatus.textContent = eventStatusLabel(event);
    els.detailStatus.className = `status-heading status-${event.classification}`;
    els.detailAgeBadge.textContent = ageLabel(h);
    els.detailFirstSeen.textContent = formatTime(event.firstSeen);
    els.detailLastSeen.textContent = formatTime(event.lastSeen);
    els.detailProvince.textContent = event.province || "Tidak diketahui";
    els.detailSensors.textContent = event.sensors.length ? event.sensors.join(", ") : "—";
    els.detailDetections.textContent = `${formatNumber(event.detectionCount)} deteksi satelit`;
    els.detailFrp.textContent = event.maxFrp === null ? "—" : `${event.maxFrp.toFixed(1)} MW maksimum`;
    els.detailCoords.textContent = `${event.latitude.toFixed(5)}, ${event.longitude.toFixed(5)}`;
    els.detailScore.textContent = `${event.score}/100`;
    els.detailVerification.textContent = event.verification === "verified"
      ? `Terverifikasi${event.verifiedBy ? ` · ${event.verifiedBy}` : ""}`
      : "Belum ada verifikasi lapangan resmi";
  }

  function renderContext() {
    const place = els.provinceFilter.value === "all" ? "Indonesia" : els.provinceFilter.value;
    els.mapContext.textContent = `${place} · ${state.filteredEvents.length} kejadian aktif · ${state.filteredDetections.length} deteksi satelit`;
  }

  function render() {
    filterData();
    renderStats();
    renderRawDetections();
    renderEvents();
    renderContext();
    if (state.status === "live") setLoading("", true);
  }

  function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function bindEvents() {
    [els.provinceFilter, els.statusFilter, els.ageFilter, els.sensorFilter].forEach(control => control.addEventListener("change", render));
    els.resetFilters.addEventListener("click", () => {
      els.provinceFilter.value = "all";
      els.statusFilter.value = "all";
      els.ageFilter.value = "all";
      els.sensorFilter.value = "all";
      render();
      map.fitBounds(INDONESIA_BOUNDS, { padding: [12, 12] });
    });
    els.fitIndonesia.addEventListener("click", () => map.fitBounds(INDONESIA_BOUNDS, { padding: [12, 12] }));
  }

  async function refreshLiveData() {
    await loadData();
    classifyLocations();
    populateFilters();
    render();
  }

  async function init() {
    bindEvents();
    await Promise.all([loadProvinces(), loadData()]);
    classifyLocations();
    populateFilters();
    render();
    window.setInterval(refreshLiveData, REFRESH_MS);
  }

  init().catch(error => {
    console.error(error);
    setStatus("error", "DATA TIDAK TERSEDIA");
    setLoading("Dashboard gagal disiapkan. Muat ulang halaman.");
  });
})();
