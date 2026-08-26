// Pure formatting helpers. No GI imports, so these are testable under plain gjs.

const COLORS = {
    green: [0x22, 0xc5, 0x5e],
    yellow: [0xea, 0xb3, 0x08],
    orange: [0xf9, 0x73, 0x16],
    red: [0xef, 0x44, 0x44],
    gray: [0x6b, 0x72, 0x80],
};

export const NEUTRAL_COLOR = COLORS.gray;

/** Usage colour, matching the thresholds the tray widgets used. */
export function colorForPercent(percent) {
    if (!Number.isFinite(percent))
        return COLORS.gray;
    if (percent < 50)
        return COLORS.green;
    if (percent < 75)
        return COLORS.yellow;
    if (percent < 90)
        return COLORS.orange;
    return COLORS.red;
}

export function clampPercent(value) {
    const percent = Number(value ?? 0);
    return Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.trunc(percent))) : 0;
}

export function parseDate(value) {
    if (!value)
        return null;
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : timestamp;
}

export function windowLabel(seconds) {
    if (!seconds)
        return 'usage';
    if (seconds % 86400 === 0)
        return `${seconds / 86400}d`;
    if (seconds % 3600 === 0)
        return `${seconds / 3600}h`;
    return `${Math.max(1, Math.trunc(seconds / 60))}m`;
}

export function prettyPlan(plan) {
    if (!plan)
        return null;
    let value = String(plan).toLowerCase();
    for (const prefix of ['self_serve_', 'chatgpt_']) {
        if (value.startsWith(prefix))
            value = value.slice(prefix.length);
    }
    return value.split('_').map(word =>
        word ? word[0].toUpperCase() + word.slice(1) : ''
    ).join(' ');
}

export function makeBar(percent, width = 20) {
    const filled = Math.max(0, Math.min(width, Math.round(percent / 100 * width)));
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function coarseDuration(seconds) {
    const days = Math.trunc(seconds / 86400);
    const hours = Math.trunc(seconds % 86400 / 3600);
    const minutes = Math.trunc(seconds % 3600 / 60);
    if (days)
        return `${days}d ${hours}h`;
    if (hours)
        return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

export function formatReset(timestamp, now = Date.now()) {
    if (!timestamp)
        return 'unknown';
    const seconds = Math.trunc((timestamp - now) / 1000);
    if (seconds <= 0)
        return 'any moment';
    return coarseDuration(seconds);
}

export function formatRetry(retryAt, now = Date.now()) {
    if (!retryAt || retryAt <= now)
        return null;
    const seconds = Math.trunc((retryAt - now) / 1000);
    if (seconds < 60)
        return 'retrying shortly';
    return `retrying in ${coarseDuration(seconds)}`;
}

export function formatAgo(updatedAt, now = Date.now()) {
    const minutes = Math.trunc((now - updatedAt) / 60000);
    if (minutes <= 0)
        return 'just now';
    return minutes === 1 ? '1 min ago' : `${minutes} mins ago`;
}
