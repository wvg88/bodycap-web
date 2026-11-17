#!/bin/bash
# Bodycap Web starten op macOS: dubbelklik dit bestand (eerste keer: rechtsklik > Open).
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
    python3 server.py "$@"
else
    echo "Python 3 is niet gevonden. Installeer het via https://www.python.org/downloads/"
    read -r -p "Druk op Enter om te sluiten..."
fi
