#!/usr/bin/env bash
set -euo pipefail

UUID="ai-usage-widget@chamith"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$INSTALL_DIR"
rm -rf "$HOME/.config/ai-usage-widget"
dconf reset -f /org/gnome/shell/extensions/ai-usage-widget/ 2>/dev/null || true

echo "AI Usage Widget removed."
