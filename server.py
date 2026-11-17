#!/usr/bin/env python3
"""
Start Bodycap Web op je eigen computer.

    python server.py            # start en opent de browser
    python server.py --port 9000
    python server.py --no-browser

Waarom een eigen server? Een webpagina mag de camera alleen gebruiken via https of
http://localhost, en JavaScript-modules laden niet als je index.html rechtstreeks
opent. De ingebouwde 'python -m http.server' geeft op Windows bovendien vaak een
verkeerd bestandstype mee voor .js-bestanden, waardoor de pagina leeg blijft.
"""

import argparse
import functools
import http.server
import socket
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent

TYPES = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json", ".wasm": "application/wasm", ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json", ".task": "application/octet-stream", ".bin": "application/octet-stream",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        return TYPES.get(Path(str(path)).suffix.lower(), "application/octet-stream")

    def end_headers(self):
        # Tijdens het ontwikkelen altijd de nieuwste versie van je eigen bestanden;
        # grote bibliotheken en modellen mag de browser wel bewaren.
        big = self.path.split("?")[0].endswith((".wasm", ".task", ".glb"))
        self.send_header("Cache-Control", "public, max-age=86400" if big else "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "--verbose" in sys.argv:
            super().log_message(fmt, *args)


def free_port(start):
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("Geen vrije poort gevonden.")


def main():
    p = argparse.ArgumentParser(description="Start Bodycap Web op http://localhost")
    p.add_argument("--port", type=int, default=8000, help="gewenste poort (standaard 8000; bezet = de volgende vrije)")
    p.add_argument("--no-browser", action="store_true", help="de browser niet automatisch openen")
    p.add_argument("--verbose", action="store_true", help="elk verzoek tonen")
    args = p.parse_args()

    port = free_port(args.port)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=str(ROOT)))
    url = f"http://localhost:{port}/"
    print(f"Bodycap Web draait op {url}")
    print("Laat dit venster open. Stoppen: Ctrl+C.")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nGestopt.")


if __name__ == "__main__":
    main()
