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
const CURSOR_USAGE_URL =
    'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const USER_AGENT = 'ai-usage-widget';
const ANTIGRAVITY_HOST = 'daily-cloudcode-pa.googleapis.com';
// The backend gates on client identity: a gemini-cli-shaped request is refused
// with SUBSCRIPTION_REQUIRED even when the token itself is valid.
const ANTIGRAVITY_UA = 'antigravity/cli/1.1.21 (aidev_client; os_type=linux; ' +
    'arch=amd64; cl=970856724; auth_method=consumer)';

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

export async function getJson(session, url, headers, cancellable, body = null) {
    const message = Soup.Message.new(body === null ? 'GET' : 'POST', url);
    for (const [name, value] of Object.entries(headers))
        message.request_headers.append(name, value);
    if (body !== null) {
        message.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
    }

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

/**
 * A provider knows where its CLI keeps credentials, which usage endpoint to
 * call, and how to read the response. `credentials()` returns null when the
 * user has not logged in, which is what hides the provider from the panel.
 */
class Provider {
    constructor(session, id, name) {
        this.id = id;
        this.name = name;
        this._session = session;
    }

    /** Whether the CLI is logged in. Malformed files count as present so the error shows. */
    isAuthenticated() {
        try {
            return this.credentials() !== null;
        } catch (_error) {
            return true;
        }
    }

    /** Hook for providers whose credentials need async work before they are readable. */
    async prepare() {}

    async fetch(cancellable) {
        const credentials = this.credentials();
        if (credentials === null)
            throw new MissingCredentialsError(this.loginHint);
        const data = await getJson(
            this._session,
            this.usageUrl,
            this.headers(credentials),
            cancellable,
            this.body ?? null
        );
        return this.parse(data);
    }
}

export class ClaudeProvider extends Provider {
    constructor(session) {
        super(session, 'claude', 'Claude');
        this.usageUrl = CLAUDE_USAGE_URL;
        this.loginHint = 'run `claude login`';
    }

    credentials() {
        const path = GLib.build_filenamev([
            GLib.get_home_dir(), '.claude', '.credentials.json',
        ]);
        const stored = readJson(path)?.claudeAiOauth ?? {};
        const token = manualToken(this.id) ?? stored.accessToken;
        return token ? {token, plan: stored.subscriptionType} : null;
    }

    headers({token}) {
        return {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': USER_AGENT,
        };
    }

    parse(data) {
        return parseClaudeUsage(data, this._plan);
    }

    async fetch(cancellable) {
        this._plan = this.credentials()?.plan ?? null;
        return super.fetch(cancellable);
    }
}

export class CodexProvider extends Provider {
    constructor(session) {
        super(session, 'codex', 'Codex');
        this.usageUrl = CODEX_USAGE_URL;
        this.loginHint = 'run `codex login`';
    }

    credentials() {
        const codexHome = GLib.getenv('CODEX_HOME') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
        const stored = readJson(
            GLib.build_filenamev([codexHome, 'auth.json'])
        )?.tokens ?? {};
        const configured = manualToken(this.id);
        const token = configured ?? stored.access_token;
        if (!token)
            return null;
        return {token, accountId: configured ? null : stored.account_id ?? null};
    }

    headers({token, accountId}) {
        const headers = {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': USER_AGENT,
        };
        if (accountId)
            headers['chatgpt-account-id'] = accountId;
        return headers;
    }

    parse(data) {
        return parseCodexUsage(data);
    }
}

export function parseCursorUsage(data) {
    const usage = data.planUsage ?? {};
    const start = Number(data.billingCycleStart);
    const end = Number(data.billingCycleEnd);
    const windows = [];
    if (Number.isFinite(end)) {
        const span = Number.isFinite(start) ? Math.round((end - start) / 1000) : 0;
        windows.push({
            label: windowLabel(span),
            percent: clampPercent(usage.totalPercentUsed),
            resetsAt: end,
        });
    }

    // Spend is reported as a bare integer of unknown unit, so report the
    // proportion used rather than a currency amount.
    const limits = data.spendLimitUsage ?? {};
    const limit = Number(limits.overallLimit);
    const remaining = Number(limits.overallRemaining);
    let extra = null;
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining))
        extra = `Spend: ${clampPercent((1 - remaining / limit) * 100)}% of limit`;

    return {plan: null, windows, extra};
}

export class CursorProvider extends Provider {
    constructor(session) {
        super(session, 'cursor', 'Cursor');
        this.usageUrl = CURSOR_USAGE_URL;
        this.loginHint = 'run `cursor-agent login`';
        this.body = {};
    }

    credentials() {
        const path = GLib.build_filenamev([
            GLib.get_user_config_dir(), 'cursor', 'auth.json',
        ]);
        const token = manualToken(this.id) ?? readJson(path)?.accessToken;
        return token ? {token} : null;
    }

    headers({token}) {
        return {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': USER_AGENT,
        };
    }

    parse(data) {
        return parseCursorUsage(data);
    }
}

/** Shorten a quota group name for the panel: "Claude and GPT models" -> "Claude/GPT". */
function groupLabel(name, fallback) {
    if (!name)
        return fallback;
    return name.replace(/\s+models$/i, '').replace(/\s+and\s+/i, '/');
}

export function parseAntigravityUsage(data, tier = null) {
    const windows = [];
    for (const group of data.groups ?? []) {
        for (const bucket of group.buckets ?? []) {
            const remaining = Number(bucket.remainingFraction);
            windows.push({
                label: groupLabel(group.displayName, bucket.bucketId ?? 'quota'),
                percent: clampPercent((1 - (Number.isFinite(remaining) ? remaining : 1)) * 100),
                resetsAt: parseDate(bucket.resetTime),
            });
        }
    }
    return {plan: tier, windows, extra: null};
}

export class AntigravityProvider extends Provider {
    constructor(session) {
        super(session, 'antigravity', 'Antigravity');
        this.loginHint = 'sign in with `agy`';
        this._secret = undefined;
        this._token = null;
        this._project = null;
        this._tier = null;
    }

    // The token lives in the keyring, so reading it is async: a synchronous
    // libsecret call would block the compositor whenever the keyring is locked.
    async prepare() {
        if (this._secret === undefined) {
            try {
                const module = await import('gi://Secret');
                this._secret = module.default;
                Gio._promisify(this._secret, 'password_lookup', 'password_lookup_finish');
            } catch (_error) {
                this._secret = null;
            }
        }
        if (!this._secret)
            return;
        try {
            const schema = new this._secret.Schema(
                'org.freedesktop.Secret.Generic',
                this._secret.SchemaFlags.NONE,
                {
                    service: this._secret.SchemaAttributeType.STRING,
                    username: this._secret.SchemaAttributeType.STRING,
                }
            );
            const raw = await this._secret.password_lookup(
                schema, {service: 'gemini', username: 'antigravity'}, null);
            this._token = raw ? JSON.parse(raw)?.token?.access_token ?? null : null;
        } catch (_error) {
            this._token = null;
        }
    }

    credentials() {
        const token = manualToken(this.id) ?? this._token;
        return token ? {token} : null;
    }

    headers({token}) {
        return {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': ANTIGRAVITY_UA,
        };
    }

    async fetch(cancellable) {
        const credentials = this.credentials();
        if (credentials === null)
            throw new MissingCredentialsError(this.loginHint);
        const headers = this.headers(credentials);

        // Quota is scoped to a per-user project that loadCodeAssist hands out.
        if (!this._project) {
            const info = await getJson(
                this._session,
                `https://${ANTIGRAVITY_HOST}/v1internal:loadCodeAssist`,
                headers, cancellable, {metadata: {ideType: 'ANTIGRAVITY'}});
            this._project = info.cloudaicompanionProject ?? null;
            this._tier = info.currentTier?.name ?? null;
        }
        if (!this._project)
            throw new ProviderError('no quota project');

        const data = await getJson(
            this._session,
            `https://${ANTIGRAVITY_HOST}/v1internal:retrieveUserQuotaSummary`,
            headers, cancellable, {project: this._project});
        return parseAntigravityUsage(data, this._tier);
    }
}
