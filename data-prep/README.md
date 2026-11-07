# Data prep

Turns public USGS LiDAR of Mount Ascutney, Vermont, into the files the viewer loads.

**Source:** USGS 3D Elevation Program (3DEP), dataset
`USGS_LPC_VT_Connecticut_River_2016_LAS_2018`, read directly from the public
[`usgs-lidar-public`](https://registry.opendata.aws/usgs-lidar/) bucket on AWS.
Public domain; no account needed.

## Requirements

[PDAL](https://pdal.io) in a conda environment named `lidar`:

```bash
conda create -n lidar -c conda-forge pdal gdal pillow
```

(`gdal` and `pillow` are only needed for step 5.)

The shell scripts call PDAL through `~/miniforge3/Scripts/conda.exe` (Miniforge on
Windows). Adjust the `PDAL=` line at the top of each script if conda lives elsewhere.

## Steps

Run everything from the repo root, in order.

| Step | Command | What it does | Output |
|---|---|---|---|
| 1 | `pdal pipeline data-prep/01-fetch.json --stream` | Downloads only the 3 × 3 km box around the summit, drops noise classes, reprojects Web Mercator → UTM 18N (EPSG:32618) so distances are true meters. | `raw/ascutney-full.laz` (~58M points) |
| 2 | `bash data-prep/02-process.sh` | Splits the crop into a 3 × 3 grid of tiles with 30 m overlap and runs `02-process-tile.json` on each: outlier removal, height above ground, and vegetation classes (3 = 0.5–2 m, 5 = over 2 m). Tiling keeps memory use low. | `raw/tiles/tile_*.laz` |
| 3 | `pdal pipeline data-prep/03-dem.json --stream` | Grids ground points (class 2) into a 1 m bare-earth height map. | `raw/ascutney-dem-1m.tif` |
| 4 | `bash data-prep/04-thin.sh [radius] [output]` | Thins each tile so no two points are closer than `radius` meters (default 1.4), zeroes fields the viewer doesn't use so they compress away, and merges into one COPC file. | `public/data/ascutney.copc.laz` |
| 5 | `python data-prep/05-heightmap.py [resolution]` | Fills gaps in the height map, resamples it (default 2 m), and packs elevations as 16-bit values (1 cm steps) into the red and green channels of a PNG the browser can decode. | `public/data/ascutney-height.png` + `.json` (~3 MB) |

Run step 1 inside the `lidar` environment (`conda activate lidar`), or prefix it
with `conda run -n lidar`.

Step 4 is the one to re-run when tuning detail versus file size; it doesn't need
steps 1–3 again. At 1.4 m the result is ~10.8M points / 89 MB, under GitHub's
100 MB file limit.

## Notes

- `raw/` is git-ignored. Everything in it can be regenerated from these scripts
  (~1.4 GB in total).
- The source data classifies only ground and unclassified points, so vegetation
  classes are derived from height above ground in step 2.
- Height above ground isn't stored in the web file; the viewer can compute it as
  a point's Z minus the height map.
- Crop bounds are hard-coded for Mount Ascutney: Web Mercator in step 1, UTM in
  steps 2 and 3.
