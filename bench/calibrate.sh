#!/usr/bin/env bash
set -u
cd /root/port
echo "[calib] start $(date -u +%FT%TZ)" > /tmp/calib.log
for i in 1 2; do
  GOMAXPROCS=1 node --experimental-strip-types bench/ab.ts \
    --base /root/port-baseline/src/bundle_multi.ts \
    --cand /root/port/src/bundle_multi.ts \
    --entry testdata/three/package/build/three.module.js \
    --n 24 --warmup 4 --out bench/ab-null-n24-run${i}.json >> /tmp/calib.log 2>&1
done
python3 bench/wall.py --entry three.module.js --n 20 --warmup 3 --out bench/wall-null-n20.json >> /tmp/calib.log 2>&1
echo "[calib] done $(date -u +%FT%TZ)" >> /tmp/calib.log
