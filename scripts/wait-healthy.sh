#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker
# usage: wait-healthy.sh <project> [tries] [sleep_s]   e.g. wait-healthy.sh mdz-demo
proj="${1:?project (e.g. mdz-demo)}"; tries="${2:-30}"; gap="${3:-2}"
probe='fetch("http://localhost:3001/api/health").then(r=>r.json()).then(j=>{if(j.status!=="ok")process.exit(1)}).catch(()=>process.exit(1))'
for _ in $(seq 1 "$tries"); do
  docker compose -p "$proj" exec -T mdz node -e "$probe" 2>/dev/null && { log "$proj healthy"; exit 0; }
  sleep "$gap"
done
die "$proj not healthy after $((tries*gap))s"
