# 🚙 MileMates: free road trip planner

**Plan the drive. Split the fuel. Enjoy the ride.**

Enter your start, destination, any stops, your dates and how many people are going. MileMates gives you:

- 🗺️ **A route map**: the real road route on OpenStreetMap, with night halts, sights, fuel stations and stays.
- 📍 **A day-by-day itinerary**: the drive is split so no day goes over your *max driving hours per day*. Night halts are real towns, and spare days become explore days at your destination.
- 🌤️ **Weather for each day**: the live forecast within 16 days, otherwise last year's weather on the same dates. Includes sunrise and sunset, a "leave by" time so you arrive before dark, and fog, ice, snow and rain warnings.
- 🛏 **Where to stay**: hotels, homestays, hostels and camps near every night halt. You can filter them, pin your pick, and open Booking.com, MakeMyTrip, Airbnb or Google Maps with the town, dates and guests already filled in.
- 💰 **Costs in ₹**: fuel (km ÷ km/l × ₹/litre × vehicles), rooms, food and tolls, all editable, split per person.
- 🎒 **A smart packing list**: tailored to the temperature, rain, altitude, group size and vehicle, with check-offs and your own items.
- ⛽ **Fuel stops**: stations along the route with km markers, the longest gap without fuel, and suggested refuel points.
- 🎲 **Bingo and fun**: Indian road-trip bingo, a playlist-length counter, chai breaks and a CO₂ estimate.
- 🔗 **Share, save and export**: a share link carries the whole trip, trips can be saved in your browser, there's a calendar export (.ics) and a print/PDF view.
- 🌙 Dark mode, phone-friendly layout, and installable as an app with offline support.

## 100% free, no API keys

| Need | Service |
|---|---|
| Map tiles | OpenStreetMap + [Leaflet](https://leafletjs.com) (bundled in `vendor/`) |
| Place search | [Photon](https://photon.komoot.io) (OpenStreetMap) |
| Driving route | [OSRM](https://project-osrm.org) public servers |
| Towns, sights, fuel, stays | [Overpass API](https://overpass-api.de) (OpenStreetMap) |
| Weather, sunrise and sunset | [Open-Meteo](https://open-meteo.com) |
| Things to do | Wikipedia geosearch |
| Hosting | GitHub Pages |

There's no backend and no build step. It's plain HTML, CSS and JavaScript modules.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(ES modules need a web server; opening `index.html` directly from disk won't work.)

## Deploy on GitHub Pages

1. Go to the repository's **Settings → Pages**.
2. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to **`main`**, folder **`/ (root)`**, and **Save**.
3. After about a minute the site is live at `https://<your-username>.github.io/road-trip-planner/`.

## Project layout

```
index.html            page structure
css/styles.css        design (light/dark, mobile, print)
js/app.js             UI: form, map, tabs, save/share/export
js/planner.js         planning logic: day split, costs, packing, bingo
js/api.js             calls to the free map/weather services
js/util.js            helpers (formatting in ₹/km, geometry, caching)
sw.js, manifest       offline support / installable app
vendor/leaflet/       Leaflet 1.9.4 (BSD-2-Clause)
```

## Notes and limits

- Drive times include a **20% buffer** over the routing engine's estimate to allow for Indian traffic, ghats and town crossings.
- Stay listings come from OpenStreetMap, so small homestays may be missing. Live prices and availability are on the booking sites.
- Tolls are a rough ₹/km estimate. Two-wheelers are toll-free on national highways.
- The free public services have fair-use limits. The app caches results and spaces out its requests.
- Estimates only. Always check road conditions, pass closures and local advisories before you go.
