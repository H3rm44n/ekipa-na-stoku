"""Copernicus GLO-30 GeoTIFF (1x1 degree) -> Terrarium-encoded PNG tiles in a PMTiles archive.
usage: dem.py DEM.tif[,DEM2.tif] OUT.pmtiles west south east north minzoom maxzoom"""
import sys, math, io
import numpy as np, tifffile
from PIL import Image
from pmtiles.writer import Writer
from pmtiles.tile import zxy_to_tileid, TileType, Compression
tif, out = sys.argv[1], sys.argv[2]
W, S, E, N = map(float, sys.argv[3:7]); Z0, Z1 = int(sys.argv[7]), int(sys.argv[8])
# One or more Copernicus 1x1 degree tiles (comma-separated); each point is sampled from the tile that contains it.
dems = []
for path in tif.split(','):
    with tifffile.TiffFile(path) as t:
        page = t.pages[0]; d = page.asarray().astype(np.float32)
        sx, sy = page.tags[33550].value[:2]; lon0, lat0 = page.tags[33922].value[3:5]
    d[d < -500] = 0
    dems.append((d, sx, sy, lon0, lat0))
def sample(lon, lat):
    out = np.zeros(lon.shape, np.float32)
    for dem, sx, sy, lon0, lat0 in dems:
        H, Wd = dem.shape
        inside = (lon >= lon0) & (lon < lon0 + Wd * sx) & (lat <= lat0) & (lat > lat0 - H * sy)
        if not inside.any(): continue
        px = (lon - lon0) / sx - 0.5; py = (lat0 - lat) / sy - 0.5
        x0 = np.clip(np.floor(px).astype(int), 0, Wd - 2); y0 = np.clip(np.floor(py).astype(int), 0, H - 2)
        fx = np.clip(px - x0, 0, 1); fy = np.clip(py - y0, 0, 1)
        a = dem[y0, x0]; b = dem[y0, x0 + 1]; c = dem[y0 + 1, x0]; d = dem[y0 + 1, x0 + 1]
        v = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
        out[inside] = v[inside]
    return out
def x_of(lon, z): return int((lon + 180) / 360 * 2 ** z)
def y_of(lat, z): lr = math.radians(lat); return int((1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * 2 ** z)
tiles = []
for z in range(Z0, Z1 + 1):
    for x in range(x_of(W, z), x_of(E, z) + 1):
        for y in range(y_of(N, z), y_of(S, z) + 1):
            tiles.append((zxy_to_tileid(z, x, y), z, x, y))
tiles.sort()
size = 256; i = np.arange(size) + 0.5
with open(out, 'wb') as f:
    w = Writer(f); total = 0
    for tid, z, x, y in tiles:
        n = 2 ** z
        lons = (x + i / size) / n * 360 - 180
        lats = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y + i / size) / n))))
        LON, LAT = np.meshgrid(lons, lats)
        h = sample(LON, LAT) + 32768.0
        r = np.floor(h / 256); g = np.floor(h) % 256; b = np.floor((h - np.floor(h)) * 256)
        img = Image.fromarray(np.dstack([r, g, b]).astype(np.uint8), 'RGB')
        buf = io.BytesIO(); img.save(buf, 'PNG', optimize=True); data = buf.getvalue()
        w.write_tile(tid, data); total += len(data)
    w.finalize({
        'tile_type': TileType.PNG, 'tile_compression': Compression.NONE,
        'min_zoom': Z0, 'max_zoom': Z1,
        'min_lon_e7': int(W * 1e7), 'min_lat_e7': int(S * 1e7), 'max_lon_e7': int(E * 1e7), 'max_lat_e7': int(N * 1e7),
        'center_zoom': Z1, 'center_lon_e7': int((W + E) / 2 * 1e7), 'center_lat_e7': int((S + N) / 2 * 1e7),
    }, {'name': 'terrain', 'encoding': 'terrarium',
        'attribution': 'Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA'})
print('tiles', len(tiles), 'bytes', total)
