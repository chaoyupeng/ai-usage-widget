# AI Usage Widget

A GNOME Shell panel widget showing Claude, Codex and Cursor usage side by side.

The panel shows each provider's icon and primary-window percentage:

```text
[Claude icon] 42%  [Codex icon] 18%  [Cursor icon] 7%
```

Providers you are not signed in to are hidden, so the panel only shows the CLIs you actually use.

Click it for the selected provider's plan, usage windows, reset times, and credits. The icon buttons at the top switch providers without closing the popup, and the last choice is remembered.

## Install

Requires GNOME Shell 47 or newer (tested on 50).

```bash
./install.sh
```

On Wayland, GNOME cannot reload extension code in place, so log out and back in after installing or updating. If the extension was not enabled automatically:

```bash
gnome-extensions enable ai-usage-widget@chamith
```

## Credentials

The widget reads the CLI credentials you already have:

- Claude: `~/.claude/.credentials.json`, written by `claude login`
- Codex: `~/.codex/auth.json`, written by `codex login`
- Cursor: `~/.config/cursor/auth.json`, written by `cursor-agent login`

To supply a token by hand instead, create `~/.config/ai-usage-widget/config.json`:

```json
{
  "providers": {
    "claude": {"oauth_token": "..."},
    "codex": {"oauth_token": "..."},
    "cursor": {"oauth_token": "..."}
  }
}
```

## Icons

The default icon is a drawn badge that changes colour with usage: green under 50%, yellow under 75%, orange under 90%, red above, and grey when usage is unknown.

To use your own artwork, drop `claude.svg`, `codex.svg`, `cursor.svg` (or `.png` / `.webp`) into `~/.config/ai-usage-widget/`, or pick a file in the extension's preferences. Custom icons keep their own colours.

```bash
gnome-extensions prefs ai-usage-widget@chamith
```

## Behavior

- Hides providers you are not signed in to, and shows them once you log in
- Refreshes every two minutes, configurable in preferences
- Marks stale percentages with `*` and keeps showing the last known figure
- Backs off on failure: 10 minutes when rate limited (or whatever `Retry-After` asks for), 2 to 10 minutes otherwise
- Reports why a provider failed in the popup, with the time until the next attempt
- Notifies at 75%, 90%, and 100%

## Tests

```bash
./tests/run.sh
```

## Uninstall

```bash
./uninstall.sh
```

## Troubleshooting

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell
```

## License

MIT. See [LICENSE](LICENSE).
