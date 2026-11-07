#!/usr/bin/env bash
# Step 2. Splits the full-density crop into a 3x3 grid of overlapping tiles and processes
# each one with 02-process-tile.json (outliers, height above ground, vegetation
# classes), so the whole cloud never has to sit in memory at once.
# Run from the repo root: bash data-prep/02-process.sh
set -euo pipefail
PDAL="$HOME/miniforge3/Scripts/conda.exe run --no-capture-output -n lidar pdal"
RAW=data-prep/raw
MINX=704653; MAXX=707749; MINY=4811489; MAXY=4814575; N=3; BUF=30
TW=$(( (MAXX-MINX+N-1)/N )); TH=$(( (MAXY-MINY+N-1)/N ))
mkdir -p $RAW/tiles
for i in $(seq 0 $((N-1))); do for j in $(seq 0 $((N-1))); do
  x0=$((MINX+i*TW)); x1=$((x0+TW)); y0=$((MINY+j*TH)); y1=$((y0+TH))
  core="([$x0,$x1],[$y0,$y1])"
  buf="([$((x0-BUF)),$((x1+BUF))],[$((y0-BUF)),$((y1+BUF))])"
  out=$RAW/tiles/tile_${i}_${j}.laz
  [ -f "$out" ] && { echo "skip $out"; continue; }
  echo "== tile $i,$j  core=$core"
  # 1) stream the buffered tile out of the big file (low memory)
  $PDAL translate $RAW/ascutney-full.laz $RAW/tiles/buf.laz crop \
    --filters.crop.bounds="$buf" --writers.las.minor_version=4 --writers.las.dataformat_id=6
  # 2) process the tile in memory, crop back to its core
  sed -e "s|TILE_IN|$RAW/tiles/buf.laz|" -e "s|TILE_OUT|$out|" -e "s|CORE_BOUNDS|$core|" \
    data-prep/02-process-tile.json > $RAW/tiles/pipeline.json
  $PDAL pipeline $RAW/tiles/pipeline.json
  rm -f $RAW/tiles/buf.laz
done; done
echo "all tiles done"
