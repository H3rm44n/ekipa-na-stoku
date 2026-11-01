# Resort packs

Each resort in the app is one pack in `docs/packs/`: `<id>.json` (pistes, lifts, huts), `<id>-base.pmtiles`
(vector map cut from the Protomaps OpenStreetMap build) and `<id>-dem.pmtiles` (Copernicus GLO-30 terrain, Terrarium PNG).
`docs/packs/catalog.json` lists them for the app.

## Add a resort
1. Add it to `resorts.json` (id, name, country, center, bbox `[south, west, north, east]`, the Copernicus 1° tile name).
2. Python env: `python3 -m venv venv && venv/bin/pip install numpy pillow tifffile imagecodecs pmtiles`.
3. Map: `venv/bin/python tools/packs/extract.py https://build.protomaps.com/<YYYYMMDD>.pmtiles docs/packs/<id>-base.pmtiles <west> <south> <east> <north> 15`
   (latest build: https://build-metadata.protomaps.dev/builds.json).
4. Terrain: download `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N46_00_E010_00_DEM/Copernicus_DSM_COG_10_N46_00_E010_00_DEM.tif`
   (change N/E to the tile), then `venv/bin/python tools/packs/dem.py <tif> docs/packs/<id>-dem.pmtiles <west-0.04> <south-0.03> <east+0.04> <north+0.04> 8 12`.
5. Pistes/huts: `node tools/packs/data.mjs <id>`.
6. `node tools/packs/catalog.mjs`, check the resort in the app (Settings → Resorts), commit.

Before adding a resort, look at its OpenStreetMap data quality (piste names/numbers, lift types) and fix gaps in OSM if needed.
Licences: see `docs/vendor/licenses/README.md`.
