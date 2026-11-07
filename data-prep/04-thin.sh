#!/usr/bin/env bash
# Step 4. Thins each processed tile with Poisson-disk sampling, zeroes fields the viewer
# doesn't use (so they compress to almost nothing), and merges the tiles into the
# web COPC file. Height above ground is not stored: the viewer computes it as
# Z minus the height grid. Re-run with a different radius to trade detail for size:
#   bash data-prep/04-thin.sh 1.4 [output.copc.laz]
set -euo pipefail
RADIUS=${1:-1.4}
PDAL="$HOME/miniforge3/Scripts/conda.exe run --no-capture-output -n lidar pdal"
RAW=data-prep/raw; OUT=${2:-public/data/ascutney.copc.laz}
mkdir -p $RAW/thin$RADIUS public/data
rm -f $RAW/thin$RADIUS/*.laz
for f in $RAW/tiles/tile_*.laz; do
  name=$(basename "$f")
  cat > $RAW/thin$RADIUS/pipeline.json <<JSON
[
  { "type": "readers.las", "filename": "$f" },
  { "type": "filters.range", "limits": "Classification![18:18]" },
  { "type": "filters.range", "limits": "HeightAboveGround[:45]" },
  { "type": "filters.sample", "radius": $RADIUS },
  { "type": "filters.assign", "value": [
      "GpsTime = 0", "PointSourceId = 0", "ScanAngleRank = 0", "UserData = 0",
      "ScanChannel = 0", "ScanDirectionFlag = 0", "EdgeOfFlightLine = 0" ] },
  { "type": "writers.las", "filename": "$RAW/thin$RADIUS/$name", "minor_version": 4,
    "dataformat_id": 6, "compression": "laszip",
    "scale_x": 0.01, "scale_y": 0.01, "scale_z": 0.01,
    "offset_x": 700000, "offset_y": 4810000, "offset_z": 0 }
]
JSON
  $PDAL pipeline $RAW/thin$RADIUS/pipeline.json
  echo "thinned $name"
done
$PDAL merge $RAW/thin$RADIUS/tile_*.laz $OUT \
  --writers.copc.scale_x=0.01 --writers.copc.scale_y=0.01 --writers.copc.scale_z=0.01
ls -la $OUT
