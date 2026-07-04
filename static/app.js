"use strict";

// ── 定数 ──────────────────────────────────────────────────
const CENTER = [35.681, 139.764];  // 丸の内エリア中心
const DEFAULT_ZOOM = 16;
const AUTO_REFRESH_MS = 5 * 60 * 1000;  // 5分ごとに混雑度更新

const CONGESTION_COLORS = {
  empty:    "#43A047",
  quiet:    "#8BC34A",
  normal:   "#FFC107",
  busy:     "#F44336",
  very_busy:"#880E4F",
};

const CONGESTION_LABELS = {
  empty:    "空いている",
  quiet:    "やや空き",
  normal:   "普通",
  busy:     "混雑",
  very_busy:"激混み",
};

const CONGESTION_ORDER = ["empty", "quiet", "normal", "busy", "very_busy"];
const LEVEL_DOTS = { empty: 0, quiet: 1, normal: 2, busy: 4, very_busy: 5 };

// ── 状態 ──────────────────────────────────────────────────
let allRestaurants = [];
let congestionMap = {};   // { restaurantId: level }
let markers = {};         // { restaurantId: L.Marker }
let sheetExpanded = false;
let activeType = "all";
let activeCrowd = "all";
let searchQuery = "";

// ── 地図初期化 ────────────────────────────────────────────
const map = L.map("map", { zoomControl: false }).setView(CENTER, DEFAULT_ZOOM);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

// 地図タップでシート折りたたみ
map.on("click", () => {
  if (sheetExpanded) setSheetState(false);
});

// ── ボトムシート制御 ───────────────────────────────────────
const sheet = document.getElementById("bottom-sheet");
const sheetHandle = document.getElementById("sheet-handle");

function setSheetState(expanded) {
  sheetExpanded = expanded;
  sheet.classList.toggle("expanded", expanded);
}

// タップでトグル
sheetHandle.addEventListener("click", () => setSheetState(!sheetExpanded));

// スワイプ操作
let touchStartY = 0;
sheetHandle.addEventListener("touchstart", e => {
  touchStartY = e.touches[0].clientY;
}, { passive: true });

sheetHandle.addEventListener("touchend", e => {
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(dy) < 8) {
    setSheetState(!sheetExpanded);
  } else if (dy > 30) {
    setSheetState(false);
  } else if (dy < -30) {
    setSheetState(true);
  }
}, { passive: true });

// ── マーカーアイコン生成 ───────────────────────────────────
function makeMarkerIcon(level) {
  const color = CONGESTION_COLORS[level] || "#9E9E9E";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38">
    <path fill="${color}" stroke="rgba(0,0,0,0.25)" stroke-width="1.2"
      d="M15 1C8.1 1 2.5 6.6 2.5 13.5c0 9.8 12.5 23.5 12.5 23.5S27.5 23.3 27.5 13.5C27.5 6.6 21.9 1 15 1z"/>
    <circle fill="white" fill-opacity="0.9" cx="15" cy="13.5" r="5.5"/>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: "",
    iconSize: [30, 38],
    iconAnchor: [15, 38],
    popupAnchor: [0, -40],
  });
}

// ── フィルタリング ─────────────────────────────────────────
function filtered() {
  return allRestaurants
    .filter(r => {
      if (activeType !== "all") {
        if (activeType === "bar") {
          if (r.amenity !== "bar" && r.amenity !== "pub") return false;
        } else {
          if (r.amenity !== activeType) return false;
        }
      }
      if (activeCrowd !== "all" && congestionMap[r.id] !== activeCrowd) return false;
      if (searchQuery) {
        const q = searchQuery;
        const inName = r.name.toLowerCase().includes(q);
        const inNameEn = (r.name_en || "").toLowerCase().includes(q);
        const inCuisine = (r.cuisine || "").toLowerCase().includes(q);
        if (!inName && !inNameEn && !inCuisine) return false;
      }
      return true;
    })
    .sort((a, b) => {
      // 混雑度が高い順に並べる
      const la = CONGESTION_ORDER.indexOf(congestionMap[a.id] || "empty");
      const lb = CONGESTION_ORDER.indexOf(congestionMap[b.id] || "empty");
      return lb - la;
    });
}

// ── 混雑メーター HTML ──────────────────────────────────────
function crowdMeterHtml(level) {
  const color = CONGESTION_COLORS[level] || "#9E9E9E";
  const filled = LEVEL_DOTS[level] ?? 0;
  const dots = Array.from({ length: 5 }, (_, i) =>
    `<span class="c-dot" style="background:${i < filled ? color : "#e0e0e0"}"></span>`
  ).join("");
  const label = CONGESTION_LABELS[level] || "不明";
  return `<div class="crowd-meter">${dots}<span class="crowd-label" style="color:${color}">${label}</span></div>`;
}

// ── リスト描画 ─────────────────────────────────────────────
function renderList() {
  const list = document.getElementById("restaurant-list");
  const items = filtered();
  document.getElementById("list-count").textContent =
    `${items.length} 件表示中 / 全 ${allRestaurants.length} 件`;

  list.innerHTML = "";
  items.forEach(r => {
    const level = congestionMap[r.id] || "empty";
    const color = CONGESTION_COLORS[level];
    const label = CONGESTION_LABELS[level];
    const li = document.createElement("li");
    li.className = "r-item";
    li.dataset.id = r.id;
    li.innerHTML = `
      <span class="r-crowd-bar" style="background:${color}"></span>
      <div class="r-item-body">
        <div class="r-name">${r.name}</div>
        <div class="r-meta">${r.amenity_label}${r.cuisine ? " · " + r.cuisine : ""}</div>
      </div>
      <span class="r-badge" style="background:${color}20;color:${color}">${label}</span>
    `;
    li.addEventListener("click", () => showDetail(r.id));
    list.appendChild(li);
  });
}

// ── マーカー描画 ───────────────────────────────────────────
function renderMarkers() {
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};

  filtered().forEach(r => {
    const level = congestionMap[r.id] || "empty";
    const m = L.marker([r.lat, r.lon], { icon: makeMarkerIcon(level) })
      .addTo(map)
      .bindTooltip(r.name, { direction: "top", offset: [0, -36], className: "map-tooltip" });
    m.on("click", () => {
      showDetail(r.id);
      setSheetState(true);
    });
    markers[r.id] = m;
  });
}

// ── 詳細表示 ───────────────────────────────────────────────
function showDetail(id) {
  const r = allRestaurants.find(x => x.id === id);
  if (!r) return;

  const level = congestionMap[r.id] || "empty";

  let html = `
    <div class="detail-name">${r.name}</div>
    ${r.name_en ? `<div class="detail-name-en">${r.name_en}</div>` : ""}
    <div class="detail-crowd-section">
      <div class="detail-crowd-title">現在の混雑状況</div>
      ${crowdMeterHtml(level)}
      <div class="detail-crowd-note">※時間帯に基づく予測値（リアルタイムデータではありません）</div>
    </div>
    <div class="detail-info">
  `;

  if (r.amenity_label) html += `<div class="detail-row"><span class="detail-icon">🏷</span><span>${r.amenity_label}${r.cuisine ? " / " + r.cuisine : ""}</span></div>`;
  if (r.opening_hours) html += `<div class="detail-row"><span class="detail-icon">🕐</span><span>${r.opening_hours}</span></div>`;
  if (r.phone)         html += `<div class="detail-row"><span class="detail-icon">📞</span><a href="tel:${r.phone}">${r.phone}</a></div>`;
  if (r.website)       html += `<div class="detail-row"><span class="detail-icon">🌐</span><a href="${r.website}" target="_blank" rel="noopener">ウェブサイト</a></div>`;
  if (r.addr)          html += `<div class="detail-row"><span class="detail-icon">📍</span><span>${r.addr}</span></div>`;
  if (!r.amenity_label && !r.opening_hours && !r.phone && !r.website && !r.addr) {
    html += `<div class="detail-row"><span>詳細情報なし</span></div>`;
  }

  html += `</div>
    <div class="detail-map-link">
      <a href="https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lon}" target="_blank" rel="noopener">
        Googleマップで開く
      </a>
    </div>
  `;

  document.getElementById("detail-content").innerHTML = html;
  document.getElementById("sheet-content").classList.add("hidden");
  document.getElementById("detail-view").classList.remove("hidden");

  if (!sheetExpanded) setSheetState(true);
  map.setView([r.lat, r.lon], Math.max(map.getZoom(), 17));
}

// ── 一覧に戻る ─────────────────────────────────────────────
document.getElementById("back-btn").addEventListener("click", () => {
  document.getElementById("detail-view").classList.add("hidden");
  document.getElementById("sheet-content").classList.remove("hidden");
});

// ── 混雑度データ取得 ───────────────────────────────────────
async function fetchCongestion() {
  try {
    const res = await fetch("/api/congestion");
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);

    congestionMap = {};
    for (const [id, level] of Object.entries(json.congestion)) {
      congestionMap[parseInt(id)] = level;
    }

    document.getElementById("update-badge").textContent = `更新 ${json.updated_at}`;
    renderMarkers();
    renderList();
  } catch (e) {
    console.error("混雑度取得エラー:", e);
  }
}

// ── レストランデータ取得 ───────────────────────────────────
async function loadRestaurants(refresh = false) {
  showLoading(refresh ? "データを更新しています..." : "データを読み込んでいます...");
  try {
    if (refresh) {
      const r = await fetch("/api/refresh");
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
    }
    const res = await fetch("/api/restaurants");
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    allRestaurants = json.restaurants;
    await fetchCongestion();
  } catch (e) {
    alert("エラー: " + e.message);
  } finally {
    hideLoading();
  }
}

// ── ローディング ───────────────────────────────────────────
function showLoading(msg) {
  document.querySelector(".loading-text").textContent = msg;
  document.getElementById("loading-overlay").classList.remove("hidden");
}
function hideLoading() {
  document.getElementById("loading-overlay").classList.add("hidden");
}

// ── イベントリスナー ───────────────────────────────────────
document.getElementById("refresh-btn").addEventListener("click", () => loadRestaurants(true));

document.getElementById("search-input").addEventListener("input", e => {
  searchQuery = e.target.value.toLowerCase().trim();
  renderMarkers();
  renderList();
});

document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeType = btn.dataset.type;
    renderMarkers();
    renderList();
  });
});

document.querySelectorAll(".crowd-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".crowd-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeCrowd = btn.dataset.crowd;
    renderMarkers();
    renderList();
  });
});

// ── 定期的に混雑度更新 ────────────────────────────────────
setInterval(fetchCongestion, AUTO_REFRESH_MS);

// ── 初期化 ────────────────────────────────────────────────
loadRestaurants();
