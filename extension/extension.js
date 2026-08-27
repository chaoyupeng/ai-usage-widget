import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    AntigravityProvider,
    ClaudeProvider,
    CodexProvider,
    CursorProvider,
    MissingCredentialsError,
    RateLimitedError,
    isCancelled,
} from './providers.js';
import {ProviderIcon, findCustomIcon} from './icons.js';
import {
    NEUTRAL_COLOR,
    colorForPercent,
    formatAgo,
    formatReset,
    formatRetry,
    makeBar,
    reservedRows,
} from './format.js';

const THRESHOLDS = [75, 90, 100];
const RATE_LIMIT_BACKOFF = 600;
const ERROR_BACKOFF = [120, 300, 600];
const CLOCK_SECONDS = 30;
const ICON_SIZE = 16;

const ProviderSwitchItem = GObject.registerClass(
class ProviderSwitchItem extends PopupMenu.PopupBaseMenuItem {
    _init(providers, selectedId, onSelected) {
        super._init({reactive: false, can_focus: false});
        this._buttons = new Map();
        this.icons = new Map();
        const box = new St.BoxLayout({style_class: 'ai-usage-switcher'});

        for (const provider of providers) {
            const content = new St.BoxLayout({
                style_class: 'ai-usage-switch-content',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const icon = new ProviderIcon(provider.id, ICON_SIZE);
            content.add_child(icon);
            content.add_child(new St.Label({
                text: provider.name,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const button = new St.Button({
                child: content,
                style_class: 'ai-usage-provider-button',
                reactive: true,
                can_focus: true,
                track_hover: true,
            });
            button.connect('clicked', () => onSelected(provider.id));
            box.add_child(button);
            this._buttons.set(provider.id, button);
            this.icons.set(provider.id, icon);
        }
        this.add_child(box);
        this.setSelected(selectedId);
    }

    setSelected(providerId) {
        for (const [id, button] of this._buttons)
            button.set_style_class_name(`ai-usage-provider-button${id === providerId ? ' selected' : ''}`);
    }

    setProviderVisible(providerId, visible) {
        this._buttons.get(providerId).visible = visible;
    }
});

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'AI usage');
        this._settings = settings;
        this._active = true;
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({timeout: 30});
        this._providers = [
            new ClaudeProvider(this._session),
            new CodexProvider(this._session),
            new CursorProvider(this._session),
            new AntigravityProvider(this._session),
        ];
        this._providersById = new Map(this._providers.map(provider => [provider.id, provider]));
        this._states = new Map(this._providers.map(provider => [provider.id, {
            snapshot: null,
            error: null,
            needsLogin: false,
            stale: false,
            updatedAt: null,
            initialized: false,
            authenticated: true,
            lastThreshold: 0,
            failures: 0,
            retryAt: null,
            inFlight: false,
        }]));
        const saved = settings.get_string('selected-provider');
        this._selectedId = this._providersById.has(saved) ? saved : this._providers[0].id;

        this._buildPanel();
        this._buildMenu();
        this._applyCustomIcons();
        for (const provider of this._providers)
            this._states.get(provider.id).authenticated = provider.isAuthenticated();
        this._updateVisibility();

        this._settingsIds = [
            settings.connect('changed::refresh-interval', () => this._restartRefreshTimer()),
            settings.connect('changed::claude-icon', () => this._applyCustomIcons()),
            settings.connect('changed::codex-icon', () => this._applyCustomIcons()),
            settings.connect('changed::cursor-icon', () => this._applyCustomIcons()),
            settings.connect('changed::antigravity-icon', () => this._applyCustomIcons()),
        ];
        this._menuId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._refreshAuthentication();
                this._renderDetails();
                this._startClock();
            } else {
                this._stopClock();
            }
        });

        this._refreshSource = null;
        this._clockSource = null;
        this._refreshAll();
        this._restartRefreshTimer();
    }

    _buildPanel() {
        this._panelIcons = new Map();
        this._panelLabels = new Map();
        this._panelGroups = new Map();
        const panel = new St.BoxLayout({
            style_class: 'ai-usage-panel',
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (const provider of this._providers) {
            const group = new St.BoxLayout({
                style_class: 'ai-usage-panel-provider',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const icon = new ProviderIcon(provider.id, ICON_SIZE);
            group.add_child(icon);
            const label = new St.Label({
                text: '--',
                style_class: 'ai-usage-provider-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            group.add_child(label);
            panel.add_child(group);
            this._panelGroups.set(provider.id, group);
            this._panelIcons.set(provider.id, icon);
            this._panelLabels.set(provider.id, label);
        }
        this._emptyLabel = new St.Label({
            text: '–',
            style_class: 'ai-usage-empty-label',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        panel.add_child(this._emptyLabel);
        this.add_child(panel);
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('ai-usage-menu');
        this._switcher = new ProviderSwitchItem(
            this._providers,
            this._selectedId,
            providerId => this._selectProvider(providerId)
        );
        this.menu.addMenuItem(this._switcher);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._planItem = this._detailItem();
        this._windowItems = Array.from({length: 4}, () => this._detailItem());
        this._extraItem = this._detailItem();
        this._emptyItem = this._detailItem();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._updatedItem = this._detailItem('Updated: never');

        const refresh = new PopupMenu.PopupMenuItem('↻ Refresh all');
        refresh.connect('activate', () => this._refreshAll({force: true}));
        this.menu.addMenuItem(refresh);
        this._renderDetails();
    }

    _detailItem(text = '') {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        this.menu.addMenuItem(item);
        return item;
    }

    _applyCustomIcons() {
        for (const provider of this._providers) {
            const override = this._settings.get_string(`${provider.id}-icon`);
            const path = findCustomIcon(provider.id, override);
            this._panelIcons.get(provider.id).setCustomIcon(path);
            this._switcher.icons.get(provider.id).setCustomIcon(path);
        }
        this._renderPanel();
    }

    _selectProvider(providerId) {
        if (!this._providersById.has(providerId))
            return;
        this._selectedId = providerId;
        this._settings.set_string('selected-provider', providerId);
        this._switcher.setSelected(providerId);
        this._renderDetails();
    }

    _restartRefreshTimer() {
        if (this._refreshSource) {
            GLib.source_remove(this._refreshSource);
            this._refreshSource = null;
        }
        if (!this._active)
            return;
        const interval = Math.max(30, this._settings.get_int('refresh-interval'));
        this._refreshSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refreshAll();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _startClock() {
        if (this._clockSource || !this._active)
            return;
        this._clockSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            CLOCK_SECONDS,
            () => {
                this._renderDetails();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopClock() {
        if (this._clockSource) {
            GLib.source_remove(this._clockSource);
            this._clockSource = null;
        }
    }

    async _refreshProvider(provider, force) {
        const state = this._states.get(provider.id);
        if (state.inFlight)
            return;
        if (!force && state.retryAt !== null && Date.now() < state.retryAt)
            return;

        state.inFlight = true;
        try {
            await provider.prepare();
            if (!this._active)
                return;
            if (!provider.isAuthenticated()) {
                state.authenticated = false;
                state.snapshot = null;
                state.error = provider.loginHint;
                state.needsLogin = true;
                state.retryAt = null;
                this._afterRefresh(provider);
                return;
            }
            state.authenticated = true;

            const snapshot = await provider.fetch(this._cancellable);
            if (!this._active)
                return;
            const firstUpdate = !state.initialized;
            state.snapshot = snapshot;
            state.error = null;
            state.needsLogin = false;
            state.stale = false;
            state.updatedAt = Date.now();
            state.initialized = true;
            state.failures = 0;
            state.retryAt = null;
            this._notifyThreshold(provider, state, firstUpdate);
        } catch (error) {
            if (!this._active || isCancelled(error))
                return;
            state.error = error.message;
            state.needsLogin = error instanceof MissingCredentialsError;
            if (state.needsLogin)
                state.authenticated = false;
            state.stale = state.snapshot !== null;
            state.retryAt = Date.now() + this._backoffFor(error, state) * 1000;
            state.failures += 1;
            console.warn(`[AI Usage] ${provider.name}: ${error.message}`);
        } finally {
            state.inFlight = false;
        }

        if (!this._active)
            return;
        this._afterRefresh(provider);
    }

    _afterRefresh(provider) {
        this._updateVisibility();
        this._renderPanel();
        // Any provider's data can change the reserved row count, so re-render
        // the details even when the provider that just landed is not selected.
        this._renderDetails();
    }

    /** Re-read credentials so a provider appears (or vanishes) without a request. */
    _refreshAuthentication() {
        for (const provider of this._providers) {
            const state = this._states.get(provider.id);
            if (!state.snapshot)
                state.authenticated = provider.isAuthenticated();
        }
        this._updateVisibility();
        this._renderPanel();
    }

    _updateVisibility() {
        let visible = 0;
        for (const provider of this._providers) {
            const shown = this._states.get(provider.id).authenticated;
            this._panelGroups.get(provider.id).visible = shown;
            this._switcher.setProviderVisible(provider.id, shown);
            if (shown)
                visible += 1;
        }
        this._emptyLabel.visible = visible === 0;

        if (visible > 0 && !this._states.get(this._selectedId).authenticated) {
            const fallback = this._providers.find(
                candidate => this._states.get(candidate.id).authenticated);
            if (fallback)
                this._selectProvider(fallback.id);
        }
    }

    _backoffFor(error, state) {
        if (error instanceof RateLimitedError)
            return error.retryAfter ?? RATE_LIMIT_BACKOFF;
        const index = Math.min(state.failures, ERROR_BACKOFF.length - 1);
        return ERROR_BACKOFF[index];
    }

    _refreshAll(options = {}) {
        if (!this._active)
            return;
        const force = Boolean(options.force);
        for (const provider of this._providers) {
            if (force)
                this._states.get(provider.id).retryAt = null;
            this._refreshProvider(provider, force).catch(error => {
                if (!isCancelled(error))
                    console.error(`[AI Usage] ${provider.name}: ${error}`);
            });
        }
    }

    _renderPanel() {
        for (const provider of this._providers) {
            const state = this._states.get(provider.id);
            const percent = state.snapshot?.windows?.[0]?.percent;
            let text;
            if (percent === undefined)
                text = state.error && !state.needsLogin ? 'ERR' : '--';
            else
                text = `${percent}%${state.stale ? '*' : ''}`;
            this._panelLabels.get(provider.id).text = text;

            const color = state.error || percent === undefined
                ? NEUTRAL_COLOR
                : colorForPercent(percent);
            this._panelIcons.get(provider.id).setColor(color);
            this._switcher.icons.get(provider.id).setColor(color);
        }
    }

    _renderDetails() {
        const now = Date.now();
        const signedIn = this._providers.some(
            provider => this._states.get(provider.id).authenticated);
        this._emptyItem.visible = !signedIn;
        if (!signedIn) {
            this._emptyItem.label.text =
                'Sign in with claude, codex, or cursor-agent';
            this._planItem.visible = false;
            this._extraItem.visible = false;
            for (const item of this._windowItems)
                item.visible = false;
            this._updatedItem.visible = false;
            return;
        }
        this._updatedItem.visible = true;

        const state = this._states.get(this._selectedId);
        const snapshot = state.snapshot;
        const states = [...this._states.values()];

        // Every provider reserves the same rows, so switching cannot resize the
        // menu. Size matters beyond looks: BoxPointer clamps the menu's x with
        // `workarea.width - (padding + natWidth)`, so on a right-hand panel a
        // menu that changes width slides sideways by the same amount.
        const rows = reservedRows(states, this._windowItems.length);
        const anyPlan = states.some(other => other.snapshot?.plan);
        const anyExtra = states.some(other => other.snapshot?.extra);

        this._planItem.visible = anyPlan;
        this._planItem.label.text = snapshot?.plan ? `Plan: ${snapshot.plan}` : '';

        for (const item of this._windowItems)
            item.visible = false;

        let row = 0;
        if (snapshot?.windows?.length) {
            snapshot.windows.slice(0, this._windowItems.length).forEach(window => {
                const item = this._windowItems[row++];
                const percent = String(window.percent).padStart(3);
                item.label.text = `${window.label}: ${makeBar(window.percent)} ` +
                    `${percent}%  resets ${formatReset(window.resetsAt, now)}`;
                item.visible = true;
            });
        }

        if (state.error && row < this._windowItems.length) {
            const item = this._windowItems[row++];
            const retry = formatRetry(state.retryAt, now);
            item.label.text = `Status: ${state.error}${retry ? ` (${retry})` : ''}`;
            item.visible = true;
        } else if (!snapshot && row < this._windowItems.length) {
            this._windowItems[row].label.text = 'Status: loading…';
            this._windowItems[row].visible = true;
            row++;
        }

        // Blank rows pad out to the reserved height.
        for (let index = row; index < rows; index++) {
            this._windowItems[index].label.text = '';
            this._windowItems[index].visible = true;
        }

        this._extraItem.visible = anyExtra;
        this._extraItem.label.text = snapshot?.extra ?? '';
        if (!state.updatedAt) {
            this._updatedItem.label.text = 'Updated: never';
            return;
        }
        const time = new Date(state.updatedAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
        });
        this._updatedItem.label.text =
            `Updated: ${time} (${formatAgo(state.updatedAt, now)})`;
    }

    _notifyThreshold(provider, state, firstUpdate) {
        if (!state.snapshot.windows.length)
            return;
        const percent = Math.max(0, ...state.snapshot.windows.map(window => window.percent));
        if (firstUpdate) {
            state.lastThreshold = Math.max(0, ...THRESHOLDS.filter(value => percent >= value));
            return;
        }
        if (percent < THRESHOLDS[0]) {
            state.lastThreshold = 0;
            return;
        }
        for (const threshold of [...THRESHOLDS].reverse()) {
            if (percent >= threshold && threshold > state.lastThreshold) {
                const usage = state.snapshot.windows
                    .map(window => `${window.label}: ${window.percent}%`)
                    .join('  |  ');
                Main.notify(`${provider.name} usage: ${threshold}%`, usage);
                state.lastThreshold = threshold;
                return;
            }
        }
    }

    destroy() {
        this._active = false;
        this._stopClock();
        if (this._refreshSource) {
            GLib.source_remove(this._refreshSource);
            this._refreshSource = null;
        }
        if (this._menuId) {
            this.menu.disconnect(this._menuId);
            this._menuId = null;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._cancellable.cancel();
        this._session.abort();
        super.destroy();
    }
});

export default class AIUsageExtension extends Extension {
    enable() {
        this._indicator = new UsageIndicator(this.getSettings());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
