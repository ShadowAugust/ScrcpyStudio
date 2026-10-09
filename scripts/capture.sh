#!/usr/bin/env bash
# Dev helper: renders each view with demo data and saves PNGs to $1.
out="${1:-captures}"; mkdir -p "$out"
for v in ${VIEWS:-devices mirror sessions media control apps files shell logcat info settings}; do
  SSTUDIO_MOCK=1 SSTUDIO_CAPTURE="$out/$v.png" SSTUDIO_VIEW=$v SSTUDIO_CAPTURE_DELAY=${DELAY:-2200} npx electron . >/dev/null 2>&1
done
