"use strict";

const CFG   = window.APP_CONFIG || {};
const I18N  = CFG.i18n || {};
const CENTER = CFG.center      || [35.685, 139.752];
const ZOOM   = CFG.defaultZoom || 14;
const AREAS  = CFG.areas       || {};

const GYM_COLOR  = "#7B1FA2";
const GYM_COLOR_D = "#6A1B9A";
const AUTO_REFRESH_MS = 15 * 60 * 1000;

const TYPE_LABELS = I18N.typeLabels || {
  fitness_centre: "フィットネス",
  sports_centre:  "スポーツセンター",
  yoga_studio:    "ヨガ",
  gym:            "ジム",
};

let allGyms        = [];
let markers        = {};
let sheetExpanded  = false;
let activeType     = "all";
let activeArea     = "all";
let searchQuery    = "";
let filterPanelOpen = false;

// ── フィルターボタン更新 ───────────────────────────────────────
function updateFilterBtn() {
  const parts = [];
  if (activeArea !== "all") parts.push(activeArea);
  if (activeType !== "all") parts.push(TYPE_LABELS[activeType] || activeType);
  const sep = I18N.filterSep || "・";
  const btn = document.getElementById("filter-toggle-btn");
  btn.textContent =
    (parts.length ? parts.join(sep) : (I18N.filterDefault || "絞り込み")) +
    (filterPanelOpen ? " ▲" : " ▼");
  btn.classList.toggle("has-filter", parts.length > 0);
}

function toggleFilterPanel() {
  filterPanelOpen = !filterPanelOpen;
  document.getElementById("filter-panel").classList.toggle("open", filterPanelOpen);
  updateFilterBtn();
}

// ── 地図初期化 ────────────────────────────────────────────────
const map = L.map("map", { zoomControl: false }).setView(CENTER, ZOOM);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

map.on("click", () => { if (sheetExpanded) setSheetState(false); });

// ── ボトムシート制御 ───────────────────────────────────────────
const sheetHandle = document.getElementById("sheet-handle");

function setSheetState(expanded) {
  sheetExpanded = expanded;
  document.getElementById("bottom-sheet").classList.toggle("expanded", expanded);
  const leg = document.getElementById("legend");
  if (leg) leg.classList.toggle("hidden", expanded);
}

sheetHandle.addEventListener("click", () => setSheetState(!sheetExpanded));

let touchStartY = 0;
sheetHandle.addEventListener("touchstart", e => {
  touchStartY = e.touches[0].clientY;
}, { passive: true });
sheetHandle.addEventListener("touchend", e => {
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(dy) < 8)  setSheetState(!sheetExpanded);
  else if (dy > 30)      setSheetState(false);
  else if (dy < -30)     setSheetState(true);
}, { passive: true });

// ── マーカーアイコン ───────────────────────────────────────────
function makeGymIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38">
    <path fill="${GYM_COLOR}" stroke="rgba(0,0,0,0.25)" stroke-width="1.2"
      d="M15 1C8.1 1 2.5 6.6 2.5 13.5c0 9.8 12.5 23.5 12.5 23.5S27.5 23.3 27.5 13.5C27.5 6.6 21.9 1 15 1z"/>
    <circle fill="white" fill-opacity="0.9" cx="15" cy="13.5" r="5.5"/>
  </svg>`;
  return L.divIcon({
    html: svg, className: "",
    iconSize: [30, 38], iconAnchor: [15, 38], popupAnchor: [0, -40],
  });
}

// ── フィルタリング ─────────────────────────────────────────────
function filtered() {
  return allGyms
    .filter(g => {
      if (activeArea !== "all") {
        const bbox = AREAS[activeArea];
        if (bbox && !(g.lat >= bbox.s && g.lat <= bbox.n && g.lon >= bbox.w && g.lon <= bbox.e))
          return false;
      }
      if (activeType !== "all" && g.type !== activeType) return false;
      if (searchQuery) {
        const nl = g.name.toLowerCase();
        const el = (g.name_en || "").toLowerCase();
        const tl = (g.type_label || "").toLowerCase();
        const sl = (g.sport || "").toLowerCase();
        if (!(nl.includes(searchQuery) || el.includes(searchQuery) ||
              tl.includes(searchQuery) || sl.includes(searchQuery)))
          return false;
      }
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

// ── リスト描画 ─────────────────────────────────────────────────
function renderList() {
  const list  = document.getElementById("restaurant-list");
  const items = filtered();
  const fmt   = I18N.countFmt || "{n} 件表示中 / 全 {total} 件";
  document.getElementById("list-count").textContent =
    fmt.replace("{n}", items.length).replace("{total}", allGyms.length);

  list.innerHTML = "";
  items.forEach(g => {
    const typeLabel = I18N.gymTypes?.[g.type] || g.type_label || g.type;
    const meta = [typeLabel, g.sport].filter(s => s && s.trim()).join(" · ");
    const li   = document.createElement("li");
    li.className = "r-item";
    li.dataset.id = g.id;
    li.innerHTML = `
      <span class="r-crowd-bar" style="background:${GYM_COLOR}"></span>
      <div class="r-item-body">
        <div class="r-name">${g.name}</div>
        <div class="r-meta">${meta || typeLabel}</div>
      </div>
      <span class="r-badge" style="background:${GYM_COLOR}20;color:${GYM_COLOR}">💪</span>
    `;
    li.addEventListener("click", () => showDetail(g.id));
    list.appendChild(li);
  });
}

// ── マーカー描画 ───────────────────────────────────────────────
function renderMarkers() {
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};
  filtered().forEach(g => {
    const m = L.marker([g.lat, g.lon], { icon: makeGymIcon() })
      .addTo(map)
      .bindTooltip(g.name, { direction: "top", offset: [0, -36], className: "map-tooltip" });
    m.on("click", () => { showDetail(g.id); setSheetState(true); });
    markers[g.id] = m;
  });
}

// ── 詳細表示 ───────────────────────────────────────────────────
function showDetail(id) {
  const g = allGyms.find(x => x.id === id);
  if (!g) return;
  const typeLabel = I18N.gymTypes?.[g.type] || g.type_label || g.type;

  let html = `
    <div class="detail-name">${g.name}</div>
    ${g.name_en ? `<div class="detail-name-en">${g.name_en}</div>` : ""}
    <div class="detail-info">
  `;
  html += `<div class="detail-row"><span class="detail-icon">🏋</span><span>${typeLabel}${g.sport ? " / " + g.sport : ""}</span></div>`;
  if (g.opening_hours) html += `<div class="detail-row"><span class="detail-icon">🕐</span><span>${g.opening_hours}</span></div>`;
  if (g.operator)      html += `<div class="detail-row"><span class="detail-icon">🏢</span><span>${g.operator}</span></div>`;
  if (g.fee) {
    const feeText = g.fee === "yes" ? (I18N.fee || "有料")
                  : g.fee === "no"  ? (I18N.freeFee || "無料")
                  : g.fee;
    html += `<div class="detail-row"><span class="detail-icon">💴</span><span>${feeText}</span></div>`;
  }
  if (g.phone)   html += `<div class="detail-row"><span class="detail-icon">📞</span><a href="tel:${g.phone}">${g.phone}</a></div>`;
  if (g.website) html += `<div class="detail-row"><span class="detail-icon">🌐</span><a href="${g.website}" target="_blank" rel="noopener">${I18N.websiteLabel || "ウェブサイト"}</a></div>`;
  if (g.addr)    html += `<div class="detail-row"><span class="detail-icon">📍</span><span>${g.addr}</span></div>`;
  if (!g.opening_hours && !g.phone && !g.website && !g.addr && !g.operator) {
    html += `<div class="detail-row"><span>${I18N.noInfo || "詳細情報なし"}</span></div>`;
  }
  html += `</div>
    <div class="detail-map-link">
      <a href="https://www.google.com/maps/search/?api=1&query=${g.lat},${g.lon}"
         target="_blank" rel="noopener">
        ${I18N.googleMapsLabel || "Googleマップで開く"}
      </a>
    </div>
  `;

  document.getElementById("detail-content").innerHTML = html;
  document.getElementById("sheet-content").classList.add("hidden");
  document.getElementById("detail-view").classList.remove("hidden");
  if (!sheetExpanded) setSheetState(true);
  map.setView([g.lat, g.lon], Math.max(map.getZoom(), 17));
}

// ── 一覧に戻る ─────────────────────────────────────────────────
document.getElementById("back-btn").addEventListener("click", () => {
  document.getElementById("detail-view").classList.add("hidden");
  document.getElementById("sheet-content").classList.remove("hidden");
});

// ── データ取得 ─────────────────────────────────────────────────
async function loadGyms(refresh = false) {
  showLoading(refresh
    ? (I18N.refreshingMsg || "データを更新しています...")
    : (I18N.loadingMsg    || "ジム情報を読み込んでいます..."));
  try {
    if (refresh) {
      const r = await fetch("/api/gyms/refresh");
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
    }
    const res  = await fetch("/api/gyms");
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    allGyms = json.gyms;

    const now = new Date();
    const hm  = now.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    document.getElementById("update-badge").textContent = (I18N.updatePrefix || "更新 ") + hm;

    renderMarkers();
    renderList();
  } catch (e) {
    alert((I18N.errorPrefix || "エラー: ") + e.message);
  } finally {
    hideLoading();
  }
}

function showLoading(msg) {
  document.querySelector(".loading-text").textContent = msg;
  document.getElementById("loading-overlay").classList.remove("hidden");
}
function hideLoading() {
  document.getElementById("loading-overlay").classList.add("hidden");
}

// ── イベントリスナー ───────────────────────────────────────────
document.getElementById("refresh-btn").addEventListener("click", () => loadGyms(true));

document.getElementById("search-input").addEventListener("input", e => {
  searchQuery = e.target.value.toLowerCase().trim();
  renderMarkers();
  renderList();
});

document.getElementById("filter-toggle-btn").addEventListener("click", toggleFilterPanel);

document.querySelectorAll(".area-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".area-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeArea = btn.dataset.area;
    updateFilterBtn();
    renderMarkers();
    renderList();
    if (activeArea !== "all" && AREAS[activeArea]) {
      const b = AREAS[activeArea];
      map.fitBounds([[b.s, b.w], [b.n, b.e]], { padding: [20, 20] });
    }
  });
});

document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeType = btn.dataset.type;
    updateFilterBtn();
    renderMarkers();
    renderList();
  });
});

// ── 定期更新 & 初期化 ─────────────────────────────────────────
setInterval(() => loadGyms(false), AUTO_REFRESH_MS);
loadGyms();
