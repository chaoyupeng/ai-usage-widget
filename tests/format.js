import {
    colorForPercent,
    formatAgo,
    formatReset,
    formatRetry,
    makeBar,
    prettyPlan,
    windowLabel,
} from '../extension/format.js';

import {assertEqual, assertDeepEqual} from './assert.js';

assertDeepEqual(colorForPercent(0), [0x22, 0xc5, 0x5e], 'green below 50');
assertDeepEqual(colorForPercent(60), [0xea, 0xb3, 0x08], 'yellow below 75');
assertDeepEqual(colorForPercent(80), [0xf9, 0x73, 0x16], 'orange below 90');
assertDeepEqual(colorForPercent(95), [0xef, 0x44, 0x44], 'red at 90+');
assertDeepEqual(colorForPercent(null), [0x6b, 0x72, 0x80], 'grey when unknown');

assertEqual(makeBar(50, 4), '██░░', 'half-filled bar');
assertEqual(makeBar(0, 4), '░░░░', 'empty bar');
assertEqual(makeBar(100, 4), '████', 'full bar');

const now = 1_000_000_000;
assertEqual(formatReset(null, now), 'unknown', 'reset without a timestamp');
assertEqual(formatReset(now - 1000, now), 'any moment', 'reset in the past');
assertEqual(formatReset(now + 5_400_000, now), '1h 30m', 'reset in hours');
assertEqual(formatReset(now + 180_000_000, now), '2d 2h', 'reset in days');

assertEqual(formatRetry(null, now), null, 'no retry when not backing off');
assertEqual(formatRetry(now - 1, now), null, 'no retry once elapsed');
assertEqual(formatRetry(now + 30_000, now), 'retrying shortly', 'sub-minute retry');
assertEqual(formatRetry(now + 600_000, now), 'retrying in 10m', 'ten-minute retry');

assertEqual(formatAgo(now, now), 'just now', 'fresh update');
assertEqual(formatAgo(now - 60_000, now), '1 min ago', 'one minute');
assertEqual(formatAgo(now - 300_000, now), '5 mins ago', 'several minutes');

assertEqual(windowLabel(18000), '5h', 'hour window');
assertEqual(windowLabel(604800), '7d', 'day window');
assertEqual(windowLabel(0), 'usage', 'missing window length');

assertEqual(prettyPlan('chatgpt_plus'), 'Plus', 'codex plan prefix stripped');
assertEqual(prettyPlan('self_serve_max'), 'Max', 'claude plan prefix stripped');
assertEqual(prettyPlan(null), null, 'no plan');

print('Format tests passed');
