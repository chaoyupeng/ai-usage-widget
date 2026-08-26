import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PROVIDERS = [
    {id: 'claude', name: 'Claude'},
    {id: 'codex', name: 'Codex'},
    {id: 'cursor', name: 'Cursor'},
];

export default class AIUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const general = new Adw.PreferencesGroup({title: 'General'});
        page.add(general);

        const interval = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between usage checks',
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 3600,
                step_increment: 30,
                page_increment: 120,
            }),
        });
        general.add(interval);
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);

        const icons = new Adw.PreferencesGroup({
            title: 'Icons',
            description: 'Leave empty for the built-in badge, or drop ' +
                '<provider>.svg / .png / .webp into ~/.config/ai-usage-widget/.',
        });
        page.add(icons);

        for (const provider of PROVIDERS)
            icons.add(this._iconRow(window, settings, provider));
    }

    _iconRow(window, settings, provider) {
        const key = `${provider.id}-icon`;
        const row = new Adw.EntryRow({title: `${provider.name} icon`});
        settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);

        const browse = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            has_frame: false,
        });
        browse.connect('clicked', () => {
            const filter = new Gtk.FileFilter({name: 'Images'});
            for (const type of ['image/svg+xml', 'image/png', 'image/webp'])
                filter.add_mime_type(type);
            const dialog = new Gtk.FileDialog({title: `Choose a ${provider.name} icon`});
            dialog.set_default_filter(filter);
            dialog.open(window, null, (source, result) => {
                try {
                    settings.set_string(key, source.open_finish(result).get_path());
                } catch (_error) {
                    // Dismissed.
                }
            });
        });
        row.add_suffix(browse);

        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            has_frame: false,
        });
        clear.connect('clicked', () => settings.set_string(key, ''));
        row.add_suffix(clear);

        return row;
    }
}
