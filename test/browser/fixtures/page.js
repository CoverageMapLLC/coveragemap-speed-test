// Test page for test/browser/worker.browser.test.ts. Runs one full engine test against the
// local speed test server and leaves everything the test checks in `window.__report`.
//
// Query parameters:
//   port         speed test server port
//   worker       '0' sets config.browserWorker to false
//   busy         '1' keeps the main thread busy 75% of the time, like a heavy page
//   cancel       '1' cancels the run half a second into the download stage
//   polyfill     '1' installs a WebSocket subclass, as a page with its own WebSocket would

const query = new URLSearchParams(location.search);
const report = {
  workersCreated: 0,
  workerAttempts: 0,
  workersTerminated: 0,
  polyfillSockets: 0,
  cspViolations: [],
  stages: [],
  pings: 0,
  downloadSnapshots: 0,
  uploadSnapshots: 0,
  busyBlocks: 0,
};
window.__report = report;

document.addEventListener('securitypolicyviolation', (event) => {
  report.cspViolations.push(event.violatedDirective);
});

// Count the workers the library starts and stops.
const NativeWorker = window.Worker;
window.Worker = class RecordingWorker extends NativeWorker {
  constructor(...args) {
    report.workerAttempts++;
    super(...args);
    report.workersCreated++;
  }
  terminate() {
    report.workersTerminated++;
    super.terminate();
  }
};

if (query.get('polyfill') === '1') {
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class PageWebSocket extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      report.polyfillSockets++;
    }
  };
}

let busyTimer = null;
if (query.get('busy') === '1') {
  // 60 ms of work every 80 ms: no socket event or timer on this thread runs in between.
  busyTimer = setInterval(() => {
    report.busyBlocks++;
    const end = performance.now() + 60;
    while (performance.now() < end) {
      // busy
    }
  }, 80);
}

const { SpeedTestEngine } = await import('./speed-test.js');

const engine = new SpeedTestEngine({
  application: {
    id: '4d7a1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
    name: 'Browser Worker Test',
    version: '1.0.0',
    organization: 'CoverageMap',
    type: 'web',
  },
  config: {
    pingCount: 5,
    downloadDurationMs: 3000,
    uploadDurationMs: 3000,
    ...(query.get('worker') === '0' ? { browserWorker: false } : {}),
  },
  api: { speedApiBaseUrl: location.origin, coverageMapApiBaseUrl: location.origin },
  callbacks: {
    onStageChange: (stage) => {
      report.stages.push(stage);
      if (stage === 'download' && query.get('cancel') === '1') setTimeout(() => engine.cancel(), 500);
    },
    onLatencyPing: () => report.pings++,
    onDownloadProgress: () => report.downloadSnapshots++,
    onUploadProgress: () => report.uploadSnapshots++,
  },
});

try {
  const result = await engine.run({
    id: 'local',
    domain: '127.0.0.1',
    port: Number(query.get('port')),
    provider: null,
    city: null,
    region: null,
    country: 'US',
    location: 'Local',
    latitude: null,
    longitude: null,
    distance: null,
    isCDN: false,
  });
  const m = result.results.measurements;
  Object.assign(report, {
    status: result.results.testStatus,
    failedReason: m.failedReason,
    protocol: result.testType.testProtocol,
    downloadMbps: m.downloadSpeed,
    uploadMbps: m.uploadSpeed,
    downloadConnections: result.testType.downloadConnectionCount,
    uploadConnections: result.testType.uploadConnectionCount,
    uploadPacketKb: result.testType.uploadPacketSize,
    downloadPacketKb: result.testType.downloadPacketSize,
    latencies: m.latenciesList?.length ?? 0,
  });
} catch (error) {
  report.status = 'threw';
  report.failedReason = String(error);
} finally {
  if (busyTimer) clearInterval(busyTimer);
  report.done = true;
}
