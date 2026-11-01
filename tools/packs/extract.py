"""Cut a bbox out of a remote PMTiles archive (HTTP range requests) into a local PMTiles file.
usage: extract.py URL OUT west south east north maxzoom"""
import sys, math, functools, urllib.request
from pmtiles.reader import Reader, find_tile, deserialize_directory
from pmtiles.writer import Writer
from pmtiles.tile import zxy_to_tileid
url, out = sys.argv[1], sys.argv[2]
W, S, E, N = map(float, sys.argv[3:7]); MAXZ = int(sys.argv[7])

@functools.lru_cache(maxsize=4096)
def get_bytes(off, length):
    req = urllib.request.Request(url, headers={'Range': f'bytes={off}-{off + length - 1}', 'User-Agent': 'ekipa-pack-builder'})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r: return r.read()
        except Exception as e:
            if attempt == 4: raise
r = Reader(get_bytes)
header, meta = r.header(), r.metadata()
def x_of(lon, z): return int((lon + 180) / 360 * 2 ** z)
def y_of(lat, z): lr = math.radians(lat); return int((1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * 2 ** z)
tiles = []
for z in range(0, MAXZ + 1):
    for x in range(x_of(W, z), x_of(E, z) + 1):
        for y in range(y_of(N, z), y_of(S, z) + 1):
            tiles.append((zxy_to_tileid(z, x, y), z, x, y))
tiles.sort()
from concurrent.futures import ThreadPoolExecutor
for z in range(0, 9): [r.get(zz, xx, yy) for _, zz, xx, yy in tiles if zz == z]   # warm the directory cache first
with ThreadPoolExecutor(16) as ex: datas = list(ex.map(lambda t: r.get(t[1], t[2], t[3]), tiles))
with open(out, 'wb') as f:
    w = Writer(f); n = 0; size = 0
    for (tid, z, x, y), data in zip(tiles, datas):
        if data: w.write_tile(tid, data); n += 1; size += len(data)
    header['min_lon_e7'], header['min_lat_e7'], header['max_lon_e7'], header['max_lat_e7'] = int(W * 1e7), int(S * 1e7), int(E * 1e7), int(N * 1e7)
    header['center_lon_e7'], header['center_lat_e7'] = int((W + E) / 2 * 1e7), int((S + N) / 2 * 1e7)
    header['max_zoom'] = min(header.get('max_zoom', MAXZ), MAXZ); header['center_zoom'] = 12
    w.finalize(header, meta)
print('tiles', n, 'bytes', size)
