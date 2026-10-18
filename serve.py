#!/usr/bin/env python3
"""Serve this offline demo on loopback with Python's standard library."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import webbrowser


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    root = Path(__file__).resolve().parent
    if not all((root / name).is_file() for name in ('index.html', 'demo.html')):
        parser.error('index.html or demo.html is missing; run python3 build.py first')
    handler = partial(SimpleHTTPRequestHandler, directory=str(root))
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    except OSError as error:
        print(f'Cannot start the local server: {error}\nTry python3 serve.py --port 8766', file=sys.stderr)
        return 1
    url = f'http://127.0.0.1:{args.port}/'
    print(f'Online SLS: {url}\nLocal access only. Press Ctrl+C to stop.', flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
