import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {NEUTRAL_COLOR} from './format.js';

const CUSTOM_EXTENSIONS = ['svg', 'png', 'webp'];

/** Path of a user-supplied icon for a provider, or null to use the drawn default. */
export function findCustomIcon(providerId, override = '') {
    if (override) {
        return GLib.file_test(override, GLib.FileTest.EXISTS) ? override : null;
    }
    const dir = GLib.build_filenamev([
        GLib.get_user_config_dir(), 'ai-usage-widget',
    ]);
    for (const extension of CUSTOM_EXTENSIONS) {
        const path = GLib.build_filenamev([dir, `${providerId}.${extension}`]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;
    }
    return null;
}

// Glyphs are drawn in a 32x32 space and scaled to the requested size.
function claudeGlyph(cr) {
    cr.setLineWidth(3);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.arcNegative(16, 16, 7, -0.25 * Math.PI, -1.75 * Math.PI);
    cr.stroke();
}

function codexGlyph(cr) {
    cr.setLineWidth(2.4);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.moveTo(10.5, 11.5);
    cr.lineTo(15.5, 16);
    cr.lineTo(10.5, 20.5);
    cr.stroke();
    cr.moveTo(18, 20.5);
    cr.lineTo(23, 20.5);
    cr.stroke();
}

function cursorGlyph(cr) {
    cr.moveTo(11.5, 8.5);
    cr.lineTo(11.5, 22.5);
    cr.lineTo(15.2, 18.8);
    cr.lineTo(17.6, 23.5);
    cr.lineTo(20.2, 22.2);
    cr.lineTo(17.9, 17.8);
    cr.lineTo(22.5, 17.2);
    cr.closePath();
    cr.fill();
}

export const GLYPHS = {
    claude: claudeGlyph,
    codex: codexGlyph,
    cursor: cursorGlyph,
};

/**
 * Provider icon: a usage-coloured drawn badge, or the user's own icon if they
 * supplied one (kept in its own colours).
 */
export const ProviderIcon = GObject.registerClass(
class ProviderIcon extends St.Bin {
    _init(providerId, size) {
        super._init({
            style_class: 'ai-usage-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._glyph = GLYPHS[providerId];
        this._size = size;
        this._color = NEUTRAL_COLOR;
        this._customPath = null;

        this._area = new St.DrawingArea({width: size, height: size});
        this._area.connect('repaint', area => this._repaint(area));
        this.set_child(this._area);
    }

    setColor(color) {
        if (this._color[0] === color[0] &&
            this._color[1] === color[1] &&
            this._color[2] === color[2])
            return;
        this._color = color;
        if (!this._customPath)
            this._area.queue_repaint();
    }

    setCustomIcon(path) {
        if (path === this._customPath)
            return;
        this._customPath = path;
        if (path) {
            this.set_child(new St.Icon({
                gicon: new Gio.FileIcon({file: Gio.File.new_for_path(path)}),
                icon_size: this._size,
            }));
        } else {
            this.set_child(this._area);
            this._area.queue_repaint();
        }
    }

    _repaint(area) {
        const cr = area.get_context();
        try {
            const [width, height] = area.get_surface_size();
            const [r, g, b] = this._color.map(value => value / 255);
            cr.save();
            cr.scale(width / 32, height / 32);
            cr.setSourceRGBA(r, g, b, 0.25);
            cr.arc(16, 16, 13, 0, 2 * Math.PI);
            cr.fill();
            cr.setSourceRGB(r, g, b);
            cr.setLineWidth(2);
            cr.arc(16, 16, 13, 0, 2 * Math.PI);
            cr.stroke();
            this._glyph(cr);
            cr.restore();
        } finally {
            cr.$dispose();
        }
    }
});
