#!/usr/bin/env bash
set -euo pipefail

UUID="ai-usage-widget@chamith"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

if ! command -v gnome-extensions >/dev/null || ! command -v glib-compile-schemas >/dev/null; then
    echo "GNOME Shell extension tools are required."
    exit 1
fi

echo "Installing AI Usage Widget..."

gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -R extension/. "$INSTALL_DIR/"
glib-compile-schemas "$INSTALL_DIR/schemas"

if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Installed and enabled."
else
    echo "Installed. Log out and back in, then run: gnome-extensions enable $UUID"
fi

if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
    echo "Wayland cannot reload extension code in place: log out and back in."
fi
