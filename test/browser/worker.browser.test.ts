// Real browser tests for the browser stage worker: the library bundled for browsers, a
// Chromium-based browser, and a local speed test server speaking the real protocol.
//
//   npm run test:browser
//
// Runs in every Chromium-based browser it finds (Chrome, Edge, Chromium), or the one in
// SPEED_TEST_BROWSER. Skips when there is none, unless REQUIRE_BROWSER=1 (CI).
import { createSpeedTestServer, type SpeedTransportServer } from '@coveragemap/speed-transport';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CANDIDATES = [
  process.env.SPEED_TEST_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const browsers = process.env.SPEED_TEST_BROWSER
  ? [process.env.SPEED_TEST_BROWSER]
  : [...new Set(CANDIDATES.filter((path): path is string => !!path && existsSync(path)))];

if (browsers.length === 0 && process.env.REQUIRE_BROWSER === '1') {
  throw new Error('No Chromium-based browser found; set SPEED_TEST_BROWSER');
}

interface Report {
  done?: boolean;
  status?: string;
  failedReason?: string | null;
  protocol?: string;
  downloadMbps?: number | null;
  uploadMbps?: number | null;
  downloadConnections?: number | null;
  uploadConnections?: number | null;
  uploadPacketKb?: number | null;
  downloadPacketKb?: number | null;
  latencies?: number;
  workersCreated: number;
  workerAttempts: number;
  workersTerminated: number;
  polyfillSockets: number;
  cspViolations: string[];
  stages: string[];
  pings: number;
  downloadSnapshots: number;
  uploadSnapshots: number;
  busyBlocks: number;
}

let speedServer: SpeedTransportServer;
let site: http.Server;
let siteOrigin: string;

beforeAll(async () => {
  speedServer = createSpeedTestServer({ websocket: { path: '/v1/ws' } });
  await speedServer.listen(0, '127.0.0.1');

  // The library as an application's bundler would ship it to browsers.
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../src/index.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    logLevel: 'error',
  });
  const library = bundle.outputFiles[0].text;
  const page = await readFile(new URL('./fixtures/page.js', import.meta.url), 'utf8');

  site = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/speed-test.js' || path === '/page.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(path === '/page.js' ? page : library);
    } else if (path === '/' || path === '/strict-csp') {
      res.setHeader('Content-Type', 'text/html');
      // A site that allows its own scripts and nothing else: no blob: workers.
      if (path === '/strict-csp') {
        res.setHeader('Content-Security-Policy', "script-src 'self'; worker-src 'self'");
      }
      res.end('<!doctype html><meta charset="utf-8"><script type="module" src="/page.js"></script>');
    } else if (path === '/v1/connection') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ client: { ip: '127.0.0.1', latitude: 0, longitude: 0, asOrg: 'Loopback' }, server: null }));
    } else {
      // Result uploads and anything else.
      req.resume();
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  siteOrigin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
}, 60000);

afterAll(async () => {
  await speedServer?.close();
  await new Promise<void>((resolve) => (site ? site.close(() => resolve()) : resolve()));
});

describe.skipIf(browsers.length === 0).each(browsers)('browser stage worker in %s', (executablePath) => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath, headless: true });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
  });

  async function run(params: Record<string, string>, path = '/'): Promise<Report> {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const query = new URLSearchParams({ port: String(speedServer.address()!.port), ...params });
      await page.goto(`${siteOrigin}${path}?${query}`);
      await page.waitForFunction(() => (window as unknown as { __report?: Report }).__report?.done === true, null, {
        timeout: 90000,
        polling: 250,
      });
      const report = await page.evaluate(() => (window as unknown as { __report: Report }).__report);
      expect(errors).toEqual([]);
      return report;
    } finally {
      await context.close();
    }
  }

  it('runs every stage in a worker', async () => {
    const report = await run({});
    expect(report.status).toBe('passed');
    expect(report.protocol).toBe('WSS');
    expect(report.workersCreated).toBe(1);
    expect(report.workersTerminated).toBe(1);
    expect(report.stages).toEqual(['latency', 'downloadEstimation', 'download', 'uploadEstimation', 'upload', 'complete']);
    expect(report.pings).toBe(5);
    expect(report.latencies).toBe(5);
    expect(report.downloadSnapshots).toBeGreaterThanOrEqual(20);
    expect(report.uploadSnapshots).toBeGreaterThanOrEqual(20);
    expect(report.downloadMbps).toBeGreaterThan(50);
    expect(report.uploadMbps).toBeGreaterThan(50);
  }, 120000);

  it('measures at full speed in a worker while the page keeps its main thread busy', async () => {
    const report = await run({ busy: '1' });
    expect(report.status).toBe('passed');
    expect(report.workersCreated).toBe(1);
    // The page really was busy for the whole run.
    expect(report.busyBlocks).toBeGreaterThan(50);
    // Loopback is far above 50 Mbps: the estimates pick the largest messages and the most
    // sockets. A collapsed estimate would pick 1 KB messages on one socket.
    expect(report.downloadPacketKb).toBe(1024);
    expect(report.uploadPacketKb).toBe(1024);
    expect(report.downloadConnections).toBeGreaterThanOrEqual(8);
    expect(report.uploadConnections).toBeGreaterThanOrEqual(8);
    expect(report.downloadMbps).toBeGreaterThan(50);
    expect(report.uploadMbps).toBeGreaterThan(50);

    // The same busy page with the stages on its main thread measures far less: the worker
    // is what keeps the page's work out of the measurement.
    const mainThread = await run({ busy: '1', worker: '0' });
    expect(mainThread.status).toBe('passed');
    expect(mainThread.workerAttempts).toBe(0);
    expect(report.downloadMbps!).toBeGreaterThan(2 * mainThread.downloadMbps!);
    expect(report.uploadMbps!).toBeGreaterThan(2 * mainThread.uploadMbps!);
  }, 180000);

  it('falls back to the main thread when the Content Security Policy blocks blob: workers', async () => {
    const report = await run({}, '/strict-csp');
    expect(report.cspViolations).toContain('worker-src');
    expect(report.workerAttempts).toBe(1);
    expect(report.status).toBe('passed');
    expect(report.pings).toBe(5);
    expect(report.downloadMbps).toBeGreaterThan(50);
    expect(report.uploadMbps).toBeGreaterThan(50);
  }, 120000);

  it('never starts a worker when browserWorker is false', async () => {
    const report = await run({ worker: '0' });
    expect(report.status).toBe('passed');
    expect(report.workerAttempts).toBe(0);
    expect(report.downloadMbps).toBeGreaterThan(50);
    expect(report.uploadMbps).toBeGreaterThan(50);
  }, 120000);

  it('keeps a WebSocket the page installed by running on the main thread', async () => {
    const report = await run({ polyfill: '1' });
    expect(report.status).toBe('passed');
    // The worker started, saw a different WebSocket than the page's, and was stopped.
    expect(report.workersCreated).toBe(1);
    expect(report.workersTerminated).toBe(1);
    expect(report.polyfillSockets).toBeGreaterThan(5);
  }, 120000);

  it('stops the worker when the run is cancelled', async () => {
    const report = await run({ cancel: '1' });
    expect(report.status).toBe('failed');
    expect(report.failedReason).toBe('Cancelled');
    expect(report.workersCreated).toBe(1);
    expect(report.workersTerminated).toBe(1);
    expect(report.stages).not.toContain('upload');
  }, 120000);
});
