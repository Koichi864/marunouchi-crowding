import json
import math
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import urllib3
import requests
from flask import Flask, jsonify, render_template

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

app = Flask(__name__)

CACHE_FILE = Path(__file__).parent / "data_cache.json"
CACHE_TTL = 3600  # 1 hour

# 東京駅〜霞が関エリアのバウンディングボックス (south,west,north,east)
AREA_BBOX = "35.663,139.742,35.696,139.782"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

AMENITY_TYPES = "restaurant|cafe|fast_food|bar|pub|food_court|ice_cream|juice_bar|snack_bar"
SHOP_TYPES    = "bakery|coffee|deli|confectionery|tea"

OVERPASS_QUERY = f"""[out:json][timeout:60];
(
  node["amenity"~"{AMENITY_TYPES}"]["name"]({AREA_BBOX});
  way["amenity"~"{AMENITY_TYPES}"]["name"]({AREA_BBOX});
  relation["amenity"~"{AMENITY_TYPES}"]["name"]({AREA_BBOX});
  node["shop"~"{SHOP_TYPES}"]["name"]({AREA_BBOX});
  way["shop"~"{SHOP_TYPES}"]["name"]({AREA_BBOX});
);
out center;
"""

AMENITY_LABELS = {
    "restaurant":    "レストラン",
    "cafe":          "カフェ",
    "fast_food":     "ファストフード",
    "bar":           "バー",
    "pub":           "パブ",
    "food_court":    "フードコート",
    "ice_cream":     "アイスクリーム",
    "juice_bar":     "ジュースバー",
    "snack_bar":     "スナック",
    "bakery":        "ベーカリー",
    "coffee":        "コーヒー",
    "deli":          "デリ",
    "confectionery": "菓子店",
    "tea":           "ティー",
}

CONGESTION_LABELS = {
    "empty":    "空いている",
    "quiet":    "やや空き",
    "normal":   "普通",
    "busy":     "混雑",
    "very_busy":"激混み",
}


HEADERS = {"User-Agent": "MarunouchiCrowdingApp/1.0 (educational project)"}

CUISINE_JP = {
    "coffee_shop": "コーヒー", "coffee": "コーヒー", "tea": "ティー",
    "japanese": "和食", "italian": "イタリアン", "french": "フレンチ",
    "chinese": "中華", "ramen": "ラーメン", "sushi": "寿司",
    "burger": "バーガー", "pizza": "ピザ", "curry": "カレー",
    "sandwich": "サンドイッチ", "steak": "ステーキ", "seafood": "シーフード",
    "udon": "うどん", "soba": "そば", "tempura": "天ぷら",
    "yakiniku": "焼肉", "tonkatsu": "とんかつ", "asian": "アジア料理",
    "american": "アメリカン", "indian": "インド料理", "thai": "タイ料理",
    "korean": "韓国料理", "ice_cream": "アイスクリーム", "donut": "ドーナツ",
    "cake": "ケーキ", "bakery": "ベーカリー", "crepe": "クレープ",
    "noodle": "麺料理", "international": "各国料理", "mediterranean": "地中海料理",
}

def translate_cuisine(raw: str) -> str:
    if not raw:
        return ""
    first = raw.split(";")[0].strip()
    return CUISINE_JP.get(first, first)


def fetch_from_overpass():
    resp = requests.post(
        OVERPASS_URL,
        data={"data": OVERPASS_QUERY},
        headers=HEADERS,
        timeout=65,
        verify=False,
    )
    resp.raise_for_status()
    elements = resp.json().get("elements", [])

    restaurants = []
    for el in elements:
        tags = el.get("tags", {})
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lon = el.get("lon") or el.get("center", {}).get("lon")
        if not lat or not lon:
            continue

        amenity = tags.get("amenity") or tags.get("shop", "")

        # 店名：branch タグがあれば「チェーン名 + 支店名」を合成
        base_name = tags.get("name", "名称不明")
        branch    = tags.get("branch") or tags.get("branch:ja", "")
        loc_name  = tags.get("loc_name", "")
        if branch and branch not in base_name:
            full_name = f"{base_name} {branch}"
        elif loc_name and loc_name not in base_name and len(loc_name) > len(base_name):
            full_name = loc_name
        else:
            full_name = base_name

        # 住所（区・丁目レベル）
        addr = (tags.get("addr:full")
                or tags.get("addr:street", "")
                or tags.get("addr:neighbourhood", ""))

        restaurants.append({
            "id":          el.get("id"),
            "name":        full_name,
            "name_en":     tags.get("name:en", ""),
            "lat":         lat,
            "lon":         lon,
            "amenity":     amenity,
            "amenity_label": AMENITY_LABELS.get(amenity, amenity),
            "cuisine":     translate_cuisine(tags.get("cuisine", "")),
            "opening_hours": tags.get("opening_hours", ""),
            "phone":       tags.get("phone") or tags.get("contact:phone", ""),
            "website":     tags.get("website") or tags.get("contact:website", ""),
            "addr":        addr,
        })

    return restaurants


def get_restaurants():
    if CACHE_FILE.exists():
        data = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        if time.time() - data["timestamp"] < CACHE_TTL:
            return data["restaurants"]

    restaurants = fetch_from_overpass()
    CACHE_FILE.write_text(
        json.dumps({"timestamp": time.time(), "restaurants": restaurants}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return restaurants


def compute_congestion(restaurant_id: int, amenity: str) -> str:
    """
    丸の内（オフィス街）の時間帯別混雑パターンをシミュレート。
    実際の混雑データAPIがないため、時刻・曜日・業態に基づく予測値を返す。
    """
    jst = timezone(timedelta(hours=9))
    now = datetime.now(jst)
    hour = now.hour + now.minute / 60
    is_weekend = now.weekday() >= 5  # 土日

    # 店舗ごとの個体差（安定した擬似乱数）
    seed = (restaurant_id % 97) / 97  # 0.0–1.0

    # 丸の内はオフィス街 → 平日ランチが最混雑、週末は閑散
    if is_weekend:
        lp, dp, bp = 0.45, 0.35, 0.15
    else:
        lp, dp, bp = 0.95, 0.68, 0.48

    def g(x: float, mu: float, sigma: float) -> float:
        return math.exp(-0.5 * ((x - mu) / sigma) ** 2)

    if hour < 6.5 or hour > 23.5:
        return "empty"

    if amenity == "cafe":
        score = max(
            bp * 1.4 * g(hour, 8.0, 0.7),     # 朝のコーヒー
            lp * 0.75 * g(hour, 12.3, 0.9),    # ランチ
            0.55 * g(hour, 15.0, 0.7),           # アフタヌーン
            dp * 0.45 * g(hour, 19.0, 1.0),     # 仕事帰り
        )
    elif amenity in ("bar", "pub"):
        score = max(
            dp * 1.1 * g(hour, 20.0, 1.3),
            0.7 * g(hour, 22.0, 1.0),
        )
    elif amenity == "fast_food":
        score = max(
            bp * 0.9 * g(hour, 8.2, 0.6),
            lp * 1.05 * g(hour, 12.0, 0.8),
            dp * 0.65 * g(hour, 18.5, 0.9),
        )
    else:  # restaurant, food_court, etc.
        score = max(
            bp * g(hour, 8.0, 0.7),
            lp * g(hour, 12.3, 1.0),
            dp * g(hour, 19.0, 1.2),
        )

    score = max(0.0, min(1.0, score + (seed - 0.5) * 0.25))

    if score < 0.12:
        return "empty"
    elif score < 0.32:
        return "quiet"
    elif score < 0.56:
        return "normal"
    elif score < 0.76:
        return "busy"
    else:
        return "very_busy"


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/guide")
def guide():
    return render_template("guide.html")


@app.route("/api/restaurants")
def api_restaurants():
    try:
        data = get_restaurants()
        return jsonify({"ok": True, "count": len(data), "restaurants": data})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/congestion")
def api_congestion():
    try:
        restaurants = get_restaurants()
        jst = timezone(timedelta(hours=9))
        now = datetime.now(jst)
        congestion = {
            str(r["id"]): compute_congestion(r["id"], r["amenity"])
            for r in restaurants
        }
        return jsonify({
            "ok":         True,
            "updated_at": now.strftime("%H:%M"),
            "congestion": congestion,
            "labels":     CONGESTION_LABELS,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/refresh")
def api_refresh():
    CACHE_FILE.unlink(missing_ok=True)
    try:
        data = get_restaurants()
        return jsonify({"ok": True, "count": len(data)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=False)
