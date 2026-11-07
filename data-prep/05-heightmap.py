"""Step 5. Packs the bare-earth height map into a browser-friendly PNG.

Browsers can only decode 8-bit PNGs reliably, so each elevation is stored as a
16-bit integer split across two channels:

    value = round((z - zMin) / zScale)      # 0..65535, 1 cm steps
    R = value >> 8,  G = value & 255,  B = 0

Rows are flipped so row 0 is the SOUTH edge: in the viewer, pixel (i, j) then
maps to x = originX + (i + 0.5) * resolution, y = originY + (j + 0.5) * resolution,
with y increasing northward like the point cloud.

Gaps (cells with no ground returns, mostly under dense canopy) are filled by
interpolation so the viewer never samples a hole.

Usage (from the repo root, in the `lidar` env):
    python data-prep/05-heightmap.py [resolution_m]
"""
import json
import sys

import numpy as np
from osgeo import gdal
from PIL import Image

gdal.UseExceptions()

SRC = "data-prep/raw/ascutney-dem-1m.tif"
OUT_PNG = "public/data/ascutney-height.png"
OUT_JSON = "public/data/ascutney-height.json"
RES = float(sys.argv[1]) if len(sys.argv) > 1 else 2.0
Z_SCALE = 0.01  # meters per step

# Fill gaps in an in-memory copy, then resample to the target resolution.
src = gdal.Open(SRC)
filled = gdal.GetDriverByName("MEM").CreateCopy("", src)
band = filled.GetRasterBand(1)
gdal.FillNodata(band, maskBand=None, maxSearchDist=200, smoothingIterations=2)

ds = gdal.Warp("", filled, format="MEM", xRes=RES, yRes=RES, resampleAlg="average")
z = ds.GetRasterBand(1).ReadAsArray().astype(np.float64)
nodata = ds.GetRasterBand(1).GetNoDataValue()
missing = int(np.sum(z == nodata)) if nodata is not None else 0
if missing:
    raise SystemExit(f"{missing} cells still empty after filling; raise maxSearchDist")

gt = ds.GetGeoTransform()  # (west, res, 0, north, 0, -res)
height, width = z.shape
origin_x = gt[0]
origin_y = gt[3] + gt[5] * height  # south edge

z_min = float(np.floor(z.min()))
q = np.round((z - z_min) / Z_SCALE)
if q.max() > 65535:
    raise SystemExit("elevation range too large for 16 bits at this zScale")
q = q.astype(np.uint16)[::-1]  # row 0 = south

rgb = np.zeros((height, width, 3), dtype=np.uint8)
rgb[..., 0] = q >> 8
rgb[..., 1] = q & 255
Image.fromarray(rgb, "RGB").save(OUT_PNG, optimize=True)

meta = {
    "crs": "EPSG:32618",
    "width": width,
    "height": height,
    "resolution": RES,
    "originX": origin_x,
    "originY": origin_y,
    "zMin": z_min,
    "zScale": Z_SCALE,
    "encoding": "R*256+G, row 0 = south",
}
with open(OUT_JSON, "w") as f:
    json.dump(meta, f, indent=2)

print(f"{width}x{height} @ {RES} m, z {z.min():.2f}-{z.max():.2f} m -> {OUT_PNG}")
