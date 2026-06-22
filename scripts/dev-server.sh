#!/usr/bin/env bash
# Tiny local dev server. Serves the extension/ directory over HTTP so
# you can open tests/runner.html in a browser without going through
# `chrome-extension://`. Useful for quick test iteration during dev.
#
# Why an HTTP server: Chrome blocks ES-module imports from file:// by
# default, which our test runner needs.
#
# Usage:
#   scripts/dev-server.sh             # binds to 127.0.0.1 on a free port
#   PORT=8000 scripts/dev-server.sh   # binds to a specific port

set -euo pipefail
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." &> /dev/null && pwd)"
cd "$REPO_ROOT/extension"

PORT="${PORT:-0}"
exec python3 -c "
import http.server, socketserver, sys
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))
port = $PORT
with socketserver.TCPServer(('127.0.0.1', port), Q) as srv:
    p = srv.server_address[1]
    print(f'Serving extension/ at http://127.0.0.1:{p}/')
    print(f'Tests:  http://127.0.0.1:{p}/tests/runner.html')
    print(f'Panel:  http://127.0.0.1:{p}/sidepanel/sidepanel.html')
    print('Ctrl-C to stop.')
    srv.serve_forever()
"
