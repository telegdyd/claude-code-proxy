const fs = require('fs');
const http = require('http');
const path = require('path');
const request = require('supertest');

jest.mock('./Logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  init: jest.fn(),
  getLogLevel: jest.fn().mockReturnValue(0)
}));

const { handleRequest } = require('./server');
const UsageStatsStore = require('./UsageStatsStore');
const ClaudeRequest = require('./ClaudeRequest');

const testDirectory = path.join(__dirname, '.test-usage-stats');

function makeStore(name = 'store') {
  return new UsageStatsStore(path.join(testDirectory, name));
}

function createUpstream(statusCode, headers, body = '') {
  const stream = new (require('stream').PassThrough)();
  stream.statusCode = statusCode;
  stream.headers = headers;
  if (body) stream.end(body);
  return stream;
}

class ClientResponse extends (require('stream').PassThrough) {
  constructor() {
    super();
    this.headers = {};
    this.headersSent = false;
    this.statusCode = 200;
  }

  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  getHeaders() { return this.headers; }
  removeHeader(name) { delete this.headers[name.toLowerCase()]; }
  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    Object.entries(headers).forEach(([name, value]) => this.setHeader(name, value));
    this.headersSent = true;
  }
  end(...args) {
    this.headersSent = true;
    return super.end(...args);
  }
}

function responseBody(response) {
  return new Promise(resolve => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('finish', () => resolve(Buffer.concat(chunks)));
  });
}

beforeEach(() => {
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

describe('UsageStatsStore', () => {
  test('persists enabled state and records metadata without request content', async () => {
    const store = makeStore('persistence');
    await store.setEnabled(false);
    expect(await store.record({ model: 'm', status: 200 })).toBe(false);

    const restarted = new UsageStatsStore(store.directory);
    expect(restarted.enabled).toBe(false);
    expect(restarted.history).toHaveLength(0);

    await restarted.setEnabled(true);
    await restarted.record({
      timestamp: '2026-10-01T12:34:00.000Z', model: 'claude-test', status: 200,
      streaming: false, usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 6 } },
      body: { prompt: 'must not be stored' }, headers: { authorization: 'secret' }
    });
    const persisted = new UsageStatsStore(store.directory);
    expect(persisted.history[0]).toEqual({
      timestamp: '2026-10-01T12:34:00.000Z', model: 'claude-test', status: 200, streaming: false,
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, 'cache_creation.ephemeral_5m_input_tokens': 6 }
    });
    expect(persisted.getStats().summary.usage).toEqual({
      input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, 'cache_creation.ephemeral_5m_input_tokens': 6
    });
  });

  test('clears request history without losing rollups and reset clears both', async () => {
    const store = makeStore('deletion');
    await Promise.all(Array.from({ length: 8 }, (_, index) => store.record({
      timestamp: '2026-10-02T01:00:00.000Z', model: 'model-a', status: 200, streaming: false,
      usage: { input_tokens: index, output_tokens: 1 }
    })));
    expect(store.getStats().summary.requests).toBe(8);
    await store.clearHistory();
    expect(store.history).toHaveLength(0);
    expect(store.getStats().summary.requests).toBe(8);
    expect(new UsageStatsStore(store.directory).getStats().summary.requests).toBe(8);
    await store.reset();
    expect(store.getStats().summary.requests).toBe(0);
    expect(store.history).toHaveLength(0);
  });

  test('keeps missing usage unknown and tolerates malformed files', async () => {
    const directory = path.join(testDirectory, 'malformed');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'requests.jsonl'), '{invalid\n{"status":"bad"}');
    fs.writeFileSync(path.join(directory, 'rollups.json'), '[null, 3]');
    fs.writeFileSync(path.join(directory, 'settings.json'), 'null');
    const store = new UsageStatsStore(directory);
    expect(store.enabled).toBe(true);
    await store.record({ model: 'unknown-usage', status: 503, streaming: true });
    expect(store.history[0].usage).toBeUndefined();
    expect(store.getStats().summary.usage).toEqual({});
  });
});

describe('production usage dashboard routes', () => {
  let server;
  let store;

  beforeEach(done => {
    store = makeStore('routes');
    server = http.createServer((req, res) => handleRequest(req, res, store));
    server.listen(0, '127.0.0.1', done);
  });

  afterEach(done => { server.close(done); });

  test('serves the dashboard and validates data and collection endpoints', async () => {
    const page = await request(server).get('/stats');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Usage, at a glance.');
    expect(page.text).toContain('id="bucket"');
    expect(page.text).toContain('id="theme-toggle"');
    expect(page.text).toContain('Cached input');
    expect(page.text).toContain('setInterval(() =>');
    const dashboardScript = page.text.match(/<script>([\s\S]*?)<\/script>/);
    expect(() => new Function(dashboardScript[1])).not.toThrow();

    expect((await request(server).get('/api/stats?range=unknown')).status).toBe(400);
    expect((await request(server).post('/api/stats')).status).toBe(405);
    expect((await request(server).put('/api/stats/settings').send({ enabled: 'false' })).status).toBe(400);
    const disabled = await request(server).put('/api/stats/settings').send({ enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.enabled).toBe(false);
    expect((await request(server).get('/api/stats/settings')).body.enabled).toBe(false);

    await store.record({ model: 'ignored', status: 200, usage: { input_tokens: 9 } });
    expect(store.history).toHaveLength(0);
  });

  test('history clear and full reset have distinct effects', async () => {
    await store.record({ timestamp: new Date().toISOString(), model: 'model-a', status: 200, usage: { input_tokens: 3 } });
    const clear = await request(server).delete('/api/stats/history');
    expect(clear.status).toBe(200);
    expect((await request(server).get('/api/stats')).body.summary.requests).toBe(1);
    expect((await request(server).get('/api/stats')).body.requests).toHaveLength(0);

    const reset = await request(server).delete('/api/stats');
    expect(reset.status).toBe(200);
    expect((await request(server).get('/api/stats')).body.summary.requests).toBe(0);
  });
});

describe('ClaudeRequest usage instrumentation', () => {
  let store;

  beforeEach(() => { store = makeStore('requests'); });

  test('captures JSON usage and final status for a non-streaming request', async () => {
    const payload = { id: 'msg', usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5 } };
    const upstreamBody = JSON.stringify(payload);
    const upstream = createUpstream(200, { 'content-type': 'application/json' }, upstreamBody);
    const claude = new ClaudeRequest(null, store);
    jest.spyOn(claude, 'makeRequest').mockResolvedValue(upstream);
    const response = new ClientResponse();
    const bodyPromise = responseBody(response);
    await claude.handleResponse(response, { model: 'claude-a', stream: false });
    expect((await bodyPromise).toString()).toBe(upstreamBody);
    await store.writeQueue;
    expect(store.history).toHaveLength(1);
    expect(store.history[0]).toMatchObject({ model: 'claude-a', status: 200, streaming: false, usage: payload.usage });
  });

  test('parses usage split across arbitrary SSE chunks and passes bytes through unchanged', async () => {
    const raw = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":4,"cache_creation_input_tokens":2,"cache_creation":{"ephemeral_5m_input_tokens":2}}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n';
    const upstream = createUpstream(200, { 'content-type': 'text/event-stream' });
    const claude = new ClaudeRequest(null, store);
    jest.spyOn(claude, 'makeRequest').mockResolvedValue(upstream);
    const response = new ClientResponse();
    const bodyPromise = responseBody(response);
    const handling = claude.handleResponse(response, { model: 'claude-stream', stream: true });
    for (let offset = 0; offset < raw.length; offset += 7) upstream.write(raw.slice(offset, offset + 7));
    upstream.end();
    await handling;
    expect((await bodyPromise).toString()).toBe(raw);
    await store.writeQueue;
    expect(store.history).toHaveLength(1);
    expect(store.history[0].usage).toEqual({ input_tokens: 12, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, 'cache_creation.ephemeral_5m_input_tokens': 2, output_tokens: 9 });
  });

  test('records failed responses with unknown usage and counts a 401 retry only once', async () => {
    const failed = createUpstream(429, { 'content-type': 'application/json' }, '{"error":"limited"}');
    const first = new ClaudeRequest(null, store);
    jest.spyOn(first, 'makeRequest').mockResolvedValue(failed);
    const failedResponse = new ClientResponse();
    const failedBody = responseBody(failedResponse);
    await first.handleResponse(failedResponse, { model: 'claude-fail' });
    await failedBody;

    const unauthorized = createUpstream(401, { 'content-type': 'application/json' }, '{"error":"expired"}');
    const success = createUpstream(200, { 'content-type': 'application/json' }, '{"usage":{"input_tokens":2,"output_tokens":3}}');
    const retry = new ClaudeRequest(null, store);
    jest.spyOn(retry, 'makeRequest').mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(success);
    jest.spyOn(retry, 'loadOrRefreshToken').mockResolvedValue('Bearer refreshed');
    const retryResponse = new ClientResponse();
    const retryBody = responseBody(retryResponse);
    await retry.handleResponse(retryResponse, { model: 'claude-retry' });
    await retryBody;
    await store.writeQueue;

    expect(store.history).toHaveLength(2);
    expect(store.history[0]).toMatchObject({ status: 429, model: 'claude-fail' });
    expect(store.history[0].usage).toBeUndefined();
    expect(store.history[1]).toMatchObject({ status: 200, model: 'claude-retry', usage: { input_tokens: 2, output_tokens: 3 } });
    expect(retry.makeRequest).toHaveBeenCalledTimes(2);
  });

  test('records connection failures with unknown usage', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const claude = new ClaudeRequest(null, store);
    jest.spyOn(claude, 'makeRequest').mockRejectedValue(new Error('offline'));
    const response = new ClientResponse();
    const bodyPromise = responseBody(response);
    await claude.handleResponse(response, { model: 'claude-offline' });
    expect(response.statusCode).toBe(500);
    await bodyPromise;
    await store.writeQueue;
    expect(store.history).toHaveLength(1);
    expect(store.history[0]).toMatchObject({ status: 500, model: 'claude-offline' });
    expect(store.history[0].usage).toBeUndefined();
    consoleError.mockRestore();
  });
});
