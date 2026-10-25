#!/bin/sh
# Double-click to start Job Pipeline and open the dashboard.
# Keep this Terminal window open while you use the app; Ctrl+C stops the server.
#
# If a server is already running on port 8787, this just opens the dashboard.

cd "$(dirname "$0")" || exit 1

URL="http://127.0.0.1:8787"

server_is_up() {
  python3 - "$URL" <<'PY' >/dev/null 2>&1
import sys
import urllib.request

try:
    with urllib.request.urlopen(sys.argv[1] + "/api/health", timeout=1.5) as response:
        sys.exit(0 if response.status == 200 else 1)
except Exception:
    sys.exit(1)
PY
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 was not found."
  echo "Install Python 3.8 or newer from https://www.python.org/downloads/ and try again."
  echo
  printf "Press Return to close this window."
  read -r _
  exit 1
fi

if server_is_up; then
  echo "Job Pipeline is already running at $URL"
  open "$URL"
  exit 0
fi

echo "Starting Job Pipeline…"
echo
python3 server.py --open
status=$?

echo
if [ "$status" -ne 0 ]; then
  echo "The server stopped with an error (exit code $status)."
else
  echo "Server stopped."
fi
printf "Press Return to close this window."
read -r _
