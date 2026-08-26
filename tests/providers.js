import {
    MissingCredentialsError,
    RateLimitedError,
    parseClaudeUsage,
    parseCodexUsage,
    parseCursorUsage,
} from '../extension/providers.js';

import {assertEqual} from './assert.js';

const claude = parseClaudeUsage({
    five_hour: {utilization: 42.9, resets_at: '2026-08-26T03:00:00Z'},
    seven_day: {utilization: 17, resets_at: '2026-08-30T00:00:00Z'},
    extra_usage: {is_enabled: true, used_credits: 5, monthly_limit: 20},
}, 'max');
assertEqual(claude.plan, 'Max', 'Claude plan');
assertEqual(claude.windows[0].label, '5h', 'Claude primary window');
assertEqual(claude.windows[0].percent, 42, 'Claude percentage');
assertEqual(claude.extra, 'Extra: 5/20 credits', 'Claude extra usage');

const empty = parseClaudeUsage({});
assertEqual(empty.windows.length, 0, 'Claude with no windows');
assertEqual(empty.extra, null, 'Claude with no extra usage');

const now = 1_000_000;
const codex = parseCodexUsage({
    plan_type: 'chatgpt_plus',
    rate_limit: {
        primary_window: {
            limit_window_seconds: 18000,
            used_percent: 18,
            reset_after_seconds: 3600,
        },
        secondary_window: {
            limit_window_seconds: 604800,
            used_percent: 66,
            reset_at: 2000,
        },
    },
    credits: {balance: 12.5},
}, now);
assertEqual(codex.plan, 'Plus', 'Codex plan');
assertEqual(codex.windows[0].label, '5h', 'Codex primary window');
assertEqual(codex.windows[1].label, '7d', 'Codex secondary window');
assertEqual(codex.windows[0].resetsAt, now + 3_600_000, 'Codex reset time');
assertEqual(codex.extra, 'Credits: 12.50', 'Codex credits');

const unlimited = parseCodexUsage({credits: {unlimited: true, overage_limit_reached: true}}, now);
assertEqual(unlimited.extra, 'Credits: unlimited (limit reached)', 'Codex unlimited credits');

assertEqual(new RateLimitedError(90).retryAfter, 90, 'rate limit honours Retry-After');
assertEqual(new RateLimitedError().retryAfter, null, 'rate limit without Retry-After');
assertEqual(new RateLimitedError().message, 'rate limited', 'rate limit message');
assertEqual(
    new MissingCredentialsError('run `claude login`').message,
    'run `claude login`',
    'credential error keeps its message'
);

// Shape captured from a live GetCurrentPeriodUsage response.
const cursor = parseCursorUsage({
    billingCycleStart: '1786240009679',
    billingCycleEnd: '1788918409679',
    planUsage: {totalPercentUsed: 42.7, autoPercentUsed: 0},
    spendLimitUsage: {overallLimit: 0, overallRemaining: 0},
});
assertEqual(cursor.windows[0].label, '31d', 'Cursor billing cycle length');
assertEqual(cursor.windows[0].percent, 42, 'Cursor percentage');
assertEqual(cursor.windows[0].resetsAt, 1788918409679, 'Cursor cycle end');
assertEqual(cursor.extra, null, 'Cursor without a spend limit');

const capped = parseCursorUsage({
    billingCycleStart: '1786240009679',
    billingCycleEnd: '1788918409679',
    planUsage: {totalPercentUsed: 10},
    spendLimitUsage: {overallLimit: 200, overallRemaining: 50},
});
assertEqual(capped.extra, 'Spend: 75% of limit', 'Cursor spend limit');

const noCycle = parseCursorUsage({});
assertEqual(noCycle.windows.length, 0, 'Cursor without a billing cycle');

print('Provider tests passed');
