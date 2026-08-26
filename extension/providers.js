import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {
    clampPercent,
    parseDate,
    prettyPlan,
    windowLabel,
} from './format.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/codex/usage';

export class ProviderError extends Error {}
export class MissingCredentialsError extends ProviderError {}

export class RateLimitedError extends ProviderError {
    constructor(retryAfter = null) {
        super('rate limited');
        this.retryAfter = retryAfter;
    }
}

export function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/** Parsed JSON, or null when the file is absent. Throws when it is unreadable JSON. */
function readJson(path) {
    let text;
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        text = new TextDecoder().decode(contents);
    } catch (_error) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch (_error) {
        throw new ProviderError(`malformed ${GLib.path_get_basename(path)}`);
    }
}

function manualToken(providerId) {
    const path = GLib.build_filenamev([
        GLib.get_user_config_dir(),
        'ai-usage-widget',
        'config.json',
    ]);
    return readJson(path)?.providers?.[providerId]?.oauth_token ?? null;
}

export async function getJson(session, url, headers, cancellable) {
    const message = Soup.Message.new('GET', url);
    for (const [name, value] of Object.entries(headers))
        message.request_headers.append(name, value);

    let bytes;
    try {
        bytes = await session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable
        );
    } catch (error) {
        if (isCancelled(error))
            throw error;
        throw new ProviderError('network unreachable');
    }

    // statusCode, not get_status(): GJS cannot marshal codes missing from the
    // Soup.Status enum, and 429 is one of them.
    const status = message.statusCode;
    if (status === 401)
        throw new ProviderError('authentication expired');
    if (status === 429) {
        const header = message.get_response_headers().get_one('Retry-After');
        const seconds = header === null ? NaN : Number(header);
        throw new RateLimitedError(Number.isFinite(seconds) ? seconds : null);
    }
    if (status < 200 || status >= 300)
        throw new ProviderError(`HTTP ${status}`);

    try {
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    } catch (_error) {
        throw new ProviderError('unreadable response');
    }
}

export function parseClaudeUsage(data, plan = null) {
    const windows = [];
    for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']]) {
        const window = data[key];
        if (window) {
            windows.push({
                label,
                percent: clampPercent(window.utilization),
                resetsAt: parseDate(window.resets_at),
            });
        }
    }

    const extra = data.extra_usage ?? {};
    const extraText = extra.is_enabled
        ? `Extra: ${Number(extra.used_credits ?? 0).toFixed(0)}/${Number(extra.monthly_limit ?? 0).toFixed(0)} credits`
        : null;
    return {
        plan: prettyPlan(plan),
        windows,
        extra: extraText,
    };
}

export function parseCodexUsage(data, now = Date.now()) {
    const limits = data.rate_limit ?? {};
    const windows = [];
    for (const key of ['primary_window', 'secondary_window']) {
        const window = limits[key];
        if (!window)
            continue;
        let resetsAt = null;
        if (window.reset_at !== null && window.reset_at !== undefined)
            resetsAt = Number(window.reset_at) * 1000;
        else if (window.reset_after_seconds !== null && window.reset_after_seconds !== undefined)
            resetsAt = now + Number(window.reset_after_seconds) * 1000;
        windows.push({
            label: windowLabel(Number(window.limit_window_seconds)),
            percent: clampPercent(window.used_percent),
            resetsAt,
        });
    }

    const credits = data.credits ?? {};
    let extra = null;
    if (credits.unlimited)
        extra = 'Credits: unlimited';
    else if (credits.balance !== null && credits.balance !== undefined)
        extra = `Credits: ${Number(credits.balance).toFixed(2)}`;
    if (extra && credits.overage_limit_reached)
        extra += ' (limit reached)';

    return {
        plan: prettyPlan(data.plan_type),
        windows,
        extra,
    };
}

export class ClaudeProvider {
    constructor(session) {
        this.id = 'claude';
        this.name = 'Claude';
        this._session = session;
    }

    async fetch(cancellable) {
        const path = GLib.build_filenamev([
            GLib.get_home_dir(), '.claude', '.credentials.json',
        ]);
        const credentials = readJson(path)?.claudeAiOauth ?? {};
        const token = manualToken(this.id) ?? credentials.accessToken;
        if (!token)
            throw new MissingCredentialsError('run `claude login`');

        const data = await getJson(this._session, CLAUDE_USAGE_URL, {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': 'ai-usage-widget',
        }, cancellable);
        return parseClaudeUsage(data, credentials.subscriptionType);
    }
}

export class CodexProvider {
    constructor(session) {
        this.id = 'codex';
        this.name = 'Codex';
        this._session = session;
    }

    async fetch(cancellable) {
        const codexHome = GLib.getenv('CODEX_HOME') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
        const credentials = readJson(
            GLib.build_filenamev([codexHome, 'auth.json'])
        )?.tokens ?? {};
        const configuredToken = manualToken(this.id);
        const token = configuredToken ?? credentials.access_token;
        if (!token)
            throw new MissingCredentialsError('run `codex login`');

        const headers = {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'ai-usage-widget',
        };
        if (!configuredToken && credentials.account_id)
            headers['chatgpt-account-id'] = credentials.account_id;

        const data = await getJson(this._session, CODEX_USAGE_URL, headers, cancellable);
        return parseCodexUsage(data);
    }
}
