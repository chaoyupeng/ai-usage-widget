// Exercises getJson against a local server: status handling here cannot be
// checked by parsing tests alone.
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {ProviderError, RateLimitedError, getJson} from '../extension/providers.js';
import {assertEqual} from './assert.js';

const server = new Soup.Server();
server.add_handler('/', (_server, message, path) => {
    const status = Number(path.slice(1)) || 200;
    if (status === 429)
        message.get_response_headers().append('Retry-After', '42');
    message.set_status(status, null);
    message.set_response('application/json', Soup.MemoryUse.COPY,
        new TextEncoder().encode('{"ok": true}'));
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
const base = server.get_uris()[0].to_string().replace(/\/$/, '');

const session = new Soup.Session();
const loop = new GLib.MainLoop(null, false);
let failure = null;

async function expectError(status, check, message) {
    try {
        await getJson(session, `${base}/${status}`, {}, null);
        throw new Error(`${message}: expected a failure`);
    } catch (error) {
        check(error, message);
    }
}

(async () => {
    try {
        const ok = await getJson(session, `${base}/200`, {}, null);
        assertEqual(ok.ok, true, 'successful response body');

        await expectError(401, (error, message) => {
            assertEqual(error instanceof ProviderError, true, message);
            assertEqual(error.message, 'authentication expired', message);
        }, '401 reports expired auth');

        await expectError(429, (error, message) => {
            assertEqual(error instanceof RateLimitedError, true, message);
            assertEqual(error.retryAfter, 42, `${message} (Retry-After)`);
        }, '429 reports a rate limit');

        await expectError(500, (error, message) => {
            assertEqual(error.message, 'HTTP 500', message);
        }, '500 reports the status');

        await expectError(503, (error, message) => {
            assertEqual(error.message, 'HTTP 503', message);
        }, '503 reports the status');
    } catch (error) {
        failure = error;
    } finally {
        loop.quit();
    }
})();

loop.run();
server.disconnect();
if (failure)
    throw failure;

print('HTTP tests passed');
