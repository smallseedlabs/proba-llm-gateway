#!/bin/sh
set -e
dir="${RUN_STORE_DIR:-/app/data/runs}"
mkdir -p "$dir"
if [ "$(id -u)" = "0" ]; then
  chown -R proba:proba /app/data
  exec su-exec proba:proba node dist/main.js
fi
exec node dist/main.js
