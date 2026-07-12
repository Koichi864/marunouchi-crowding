import json
import math
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import urllib3
import requests
from flask import Flask, jsonify, render_template, request

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

app = Flask(__name__)

CACHE_TTL = 3600  # 1 hour

AMENITY_TYPES = "restaurant|cafe|fast_food|bar|pub|food_court|ice_cream|juice_bar|snack_bar"
SHOP_TYPES    = "bakery|coffee|deli|confectionery|tea"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
HEADERS = {"User-Agent": "MarunouchiCrowdingApp/1.0 (educational project)"}

CITY_CONFIG = {
    "marunouchi": {
        "bbox":       "35.660,139.726,35.696,139.782",
        "cache_file": Path(__file__).parent / "data_cache_marunouchi.json",
    },
    "nagaoka": {
        "bbox":       "37.425,138.825,37.480,138.885",
        "cache_file": Path(__file__).parent / "data_cache_nagaoka.json",
    },
}

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
    "empty":     "空いている",
    "quiet":     "やや空き",
    "normal":    "普通",
    "busy":      "混雑",
    "very_busy": "激混み",
}

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


def build_overpass_query(bbox):
    return f"""[out:json][timeout:60];
(
  node["amenity"~"{AMENITY_TYPES}"]["name"]({bbox});
  way["amenity"~"{AMENITY_TYPES}"]["name"]({bbox});
  relation["amenity"~"{AMENITY_TYPES}"]["name"]({bbox});
  node["shop"~"{SHOP_TYPES}"]["name"]({bbox});
  way["shop"~"{SHOP_TYPES}"]["name"]({bbox});
);
out center;
"""


def fetch_from_overpass(bbox):
    resp = requests.post(
        OVERPASS_URL,
        data={"data": build_overpass_query(bbox)},
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

        base_name = tags.get("name", "名称不明")
        branch    = tags.get("branch") or tags.get("branch:ja", "")
        loc_name  = tags.get("loc_name", "")
        if branch and branch not in base_name:
            full_name = f"{base_name} {branch}"
        elif loc_name and loc_name not in base_name and len(loc_name) > len(base_name):
            full_name = loc_name
        else:
            full_name = base_name

        addr = (tags.get("addr:full")
                or tags.get("addr:street", "")
                or tags.get("addr:neighbourhood", ""))

        restaurants.append({
            "id":            el.get("id"),
            "name":          full_name,
            "name_en":       tags.get("name:en", ""),
            "lat":           lat,
            "lon":           lon,
            "amenity":       amenity,
            "amenity_label": AMENITY_LABELS.get(amenity, amenity),
            "cuisine":       translate_cuisine(tags.get("cuisine", "")),
            "opening_hours": tags.get("opening_hours", ""),
            "phone":         tags.get("phone") or tags.get("contact:phone", ""),
            "website":       tags.get("website") or tags.get("contact:website", ""),
            "addr":          addr,
        })

    return restaurants


def get_restaurants(city="marunouchi"):
    cfg = CITY_CONFIG.get(city, CITY_CONFIG["marunouchi"])
    cache_file = cfg["cache_file"]

    if cache_file.exists():
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        if time.time() - data["timestamp"] < CACHE_TTL:
            return data["restaurants"]

    restaurants = fetch_from_overpass(cfg["bbox"])
    cache_file.write_text(
        json.dumps({"timestamp": time.time(), "restaurants": restaurants},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return restaurants


def compute_congestion(restaurant_id: int, amenity: str) -> str:
    jst = timezone(timedelta(hours=9))
    now = datetime.now(jst)
    hour = now.hour + now.minute / 60
    is_weekend = now.weekday() >= 5

    seed = (restaurant_id % 97) / 97

    if is_weekend:
        lp, dp, bp = 0.45, 0.35, 0.15
    else:
        lp, dp, bp = 0.95, 0.68, 0.48

    def g(x, mu, sigma):
        return math.exp(-0.5 * ((x - mu) / sigma) ** 2)

    if hour < 6.5 or hour > 23.5:
        return "empty"

    if amenity == "cafe":
        score = max(
            bp * 1.4 * g(hour, 8.0, 0.7),
            lp * 0.75 * g(hour, 12.3, 0.9),
            0.55 * g(hour, 15.0, 0.7),
            dp * 0.45 * g(hour, 19.0, 1.0),
        )
    elif amenity in ("bar", "pub"):
        score = max(
            dp * 1.1 * g(hour, 20.0, 1.3),
            0.7  * g(hour, 22.0, 1.0),
        )
    elif amenity == "fast_food":
        score = max(
            bp * 0.9  * g(hour, 8.2,  0.6),
            lp * 1.05 * g(hour, 12.0, 0.8),
            dp * 0.65 * g(hour, 18.5, 0.9),
        )
    else:
        score = max(
            bp * g(hour, 8.0,  0.7),
            lp * g(hour, 12.3, 1.0),
            dp * g(hour, 19.0, 1.2),
        )

    score = max(0.0, min(1.0, score + (seed - 0.5) * 0.25))

    if score < 0.12:   return "empty"
    elif score < 0.32: return "quiet"
    elif score < 0.56: return "normal"
    elif score < 0.76: return "busy"
    else:              return "very_busy"


def valid_city(city):
    return city if city in CITY_CONFIG else "marunouchi"


# ── ジムマップ ────────────────────────────────────────────────

GYM_BBOX = "35.660,139.700,35.715,139.790"  # 皇居周辺エリア
GYM_CACHE_FILE = Path(__file__).parent / "data_cache_gym.json"

GYM_LEISURE_LABELS = {
    "fitness_centre": "フィットネスジム",
    "sports_centre":  "スポーツセンター",
    "yoga_studio":    "ヨガスタジオ",
    "gym":            "ジム",
}

GYM_SPORT_LABELS = {
    "fitness":       "フィットネス",
    "yoga":          "ヨガ",
    "pilates":       "ピラティス",
    "swimming":      "水泳",
    "martial_arts":  "格闘技",
    "weightlifting": "ウエイトトレーニング",
    "climbing":      "クライミング",
    "dance":         "ダンス",
    "athletics":     "陸上",
    "running":       "ランニング",
    "tennis":        "テニス",
    "badminton":     "バドミントン",
    "gymnastics":    "体操",
    "boxing":        "ボクシング",
}

GYM_OVERPASS_QUERY = f"""[out:json][timeout:60];
(
  node["leisure"~"fitness_centre|sports_centre|yoga_studio"]["name"]({GYM_BBOX});
  way["leisure"~"fitness_centre|sports_centre|yoga_studio"]["name"]({GYM_BBOX});
  node["amenity"="gym"]["name"]({GYM_BBOX});
  way["amenity"="gym"]["name"]({GYM_BBOX});
);
out center;
"""


def fetch_gyms_from_overpass():
    resp = requests.post(
        OVERPASS_URL,
        data={"data": GYM_OVERPASS_QUERY},
        headers=HEADERS,
        timeout=65,
        verify=False,
    )
    resp.raise_for_status()
    elements = resp.json().get("elements", [])

    gyms = []
    for el in elements:
        tags = el.get("tags", {})
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lon = el.get("lon") or el.get("center", {}).get("lon")
        if not lat or not lon:
            continue

        gym_type = tags.get("leisure") or tags.get("amenity", "gym")
        sport_raw = tags.get("sport", "")
        sport_label = GYM_SPORT_LABELS.get(sport_raw.split(";")[0].strip(), sport_raw)

        gyms.append({
            "id":            el.get("id"),
            "name":          tags.get("name", "名称不明"),
            "name_en":       tags.get("name:en", ""),
            "lat":           lat,
            "lon":           lon,
            "type":          gym_type,
            "type_label":    GYM_LEISURE_LABELS.get(gym_type, gym_type),
            "sport":         sport_label,
            "opening_hours": tags.get("opening_hours", ""),
            "phone":         tags.get("phone") or tags.get("contact:phone", ""),
            "website":       tags.get("website") or tags.get("contact:website", ""),
            "addr":          (tags.get("addr:full")
                              or tags.get("addr:street", "")
                              or tags.get("addr:neighbourhood", "")),
            "fee":           tags.get("fee", ""),
            "operator":      tags.get("operator", ""),
        })

    return gyms


def get_gyms():
    if GYM_CACHE_FILE.exists():
        data = json.loads(GYM_CACHE_FILE.read_text(encoding="utf-8"))
        if time.time() - data["timestamp"] < CACHE_TTL:
            return data["gyms"]

    gyms = fetch_gyms_from_overpass()
    GYM_CACHE_FILE.write_text(
        json.dumps({"timestamp": time.time(), "gyms": gyms},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return gyms


# ── ルート ────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/en")
def index_en():
    return render_template("index_en.html")

@app.route("/es")
def index_es():
    return render_template("index_es.html")

@app.route("/nagaoka")
def nagaoka():
    return render_template("nagaoka.html")

@app.route("/gym")
def gym_jp():
    return render_template("gym.html")

@app.route("/gym/en")
def gym_en_route():
    return render_template("gym_en.html")

@app.route("/gym/es")
def gym_es_route():
    return render_template("gym_es.html")

@app.route("/guide")
def guide():
    return render_template("guide.html")


# ── API ───────────────────────────────────────────────────────

@app.route("/api/restaurants")
def api_restaurants():
    city = valid_city(request.args.get("city", "marunouchi"))
    try:
        data = get_restaurants(city)
        return jsonify({"ok": True, "count": len(data), "restaurants": data})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/congestion")
def api_congestion():
    city = valid_city(request.args.get("city", "marunouchi"))
    try:
        restaurants = get_restaurants(city)
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


@app.route("/api/gyms")
def api_gyms():
    try:
        data = get_gyms()
        return jsonify({"ok": True, "count": len(data), "gyms": data})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/gyms/refresh")
def api_gyms_refresh():
    GYM_CACHE_FILE.unlink(missing_ok=True)
    try:
        data = get_gyms()
        return jsonify({"ok": True, "count": len(data)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/refresh")
def api_refresh():
    city = valid_city(request.args.get("city", "marunouchi"))
    CITY_CONFIG[city]["cache_file"].unlink(missing_ok=True)
    try:
        data = get_restaurants(city)
        return jsonify({"ok": True, "count": len(data)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=False)
