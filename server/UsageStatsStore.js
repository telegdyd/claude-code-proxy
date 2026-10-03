const fs = require('fs');
const os = require('os');
const path = require('path');

const TOKEN_FIELD = /_tokens$/;

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const normalized = {};
  const visit = (fields, prefix = '') => {
    for (const [key, value] of Object.entries(fields)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        visit(value, name);
      } else if (TOKEN_FIELD.test(key) && Number.isFinite(value) && value >= 0) {
        normalized[name] = value;
      }
    }
  };
  visit(usage);
  return Object.keys(normalized).length ? normalized : null;
}

function safeRead(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

class UsageStatsStore {
  constructor(directory = path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.claude-code-proxy', 'stats')) {
    this.directory = directory;
    this.historyPath = path.join(directory, 'requests.jsonl');
    this.rollupsPath = path.join(directory, 'rollups.json');
    this.settingsPath = path.join(directory, 'settings.json');
    const rollups = safeRead(this.rollupsPath, []);
    const settings = safeRead(this.settingsPath, { enabled: true });
    this.enabled = settings && typeof settings.enabled === 'boolean' ? settings.enabled : true;
    this.history = this.loadHistory();
    this.rollups = Array.isArray(rollups) ? rollups.filter(item => item && typeof item === 'object' && typeof item.hour === 'string' && !Number.isNaN(Date.parse(item.hour)) && typeof item.model === 'string' && Number.isFinite(item.requests) && item.requests >= 0).map(item => ({
      hour: item.hour,
      model: item.model,
      requests: item.requests,
      statuses: item.statuses && typeof item.statuses === 'object' && !Array.isArray(item.statuses) ? Object.fromEntries(Object.entries(item.statuses).filter(([status, count]) => /^\d{3}$/.test(status) && Number.isFinite(count) && count >= 0)) : {},
      usage: normalizeUsage(item.usage) || {}
    })) : [];
    this.writeQueue = Promise.resolve();
  }

  loadHistory() {
    try {
      return fs.readFileSync(this.historyPath, 'utf8').split('\n')
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line); } catch (error) { return null; }
        })
        .filter(item => item && typeof item === 'object' && typeof item.timestamp === 'string' && typeof item.model === 'string' && Number.isInteger(item.status) && typeof item.streaming === 'boolean')
        .map(item => {
          const usage = normalizeUsage(item.usage);
          return { timestamp: item.timestamp, model: item.model, status: item.status, streaming: item.streaming, ...(usage ? { usage } : {}) };
        }).slice(-50);
    } catch (error) {
      return [];
    }
  }

  serializeWrite(write) {
    const next = this.writeQueue.catch(() => {}).then(write);
    this.writeQueue = next;
    return next;
  }

  ensureDirectory() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(this.directory, 0o700);
  }

  writeJson(filePath, data) {
    this.ensureDirectory();
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, filePath);
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    return this.serializeWrite(() => {
      this.enabled = enabled;
      this.writeJson(this.settingsPath, { enabled });
      return { enabled: this.enabled };
    });
  }

  record(metadata) {
    return this.serializeWrite(() => {
      if (!this.enabled) return false;

      const timestamp = metadata.timestamp || new Date().toISOString();
      const usage = normalizeUsage(metadata.usage);
      const record = {
        timestamp,
        model: typeof metadata.model === 'string' ? metadata.model : 'unknown',
        status: Number.isInteger(metadata.status) ? metadata.status : 500,
        streaming: metadata.streaming === true
      };
      if (usage) record.usage = usage;
      this.history.push(record);
      if (this.history.length > 50) this.history.shift();

      const hour = new Date(timestamp);
      hour.setUTCMinutes(0, 0, 0);
      const hourKey = Number.isNaN(hour.getTime()) ? new Date().toISOString().slice(0, 13) + ':00:00.000Z' : hour.toISOString();
      let rollup = this.rollups.find(item => item.hour === hourKey && item.model === record.model);
      if (!rollup) {
        rollup = { hour: hourKey, model: record.model, requests: 0, statuses: {}, usage: {} };
        this.rollups.push(rollup);
      }
      rollup.requests += 1;
      const statusKey = String(record.status);
      rollup.statuses[statusKey] = (rollup.statuses[statusKey] || 0) + 1;
      if (usage) {
        for (const [key, value] of Object.entries(usage)) {
          rollup.usage[key] = (rollup.usage[key] || 0) + value;
        }
      }
      this.ensureDirectory();
      fs.appendFileSync(this.historyPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(this.historyPath, 0o600);
      this.writeJson(this.rollupsPath, this.rollups);
      return true;
    });
  }

  getStats(range = 'all') {
    const durations = { '24h': 24 * 60 * 60 * 1000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
    const cutoff = durations[range] ? Date.now() - durations[range] : null;
    const rollups = this.rollups
      .filter(item => cutoff === null || Date.parse(item.hour) >= cutoff)
      .sort((a, b) => a.hour.localeCompare(b.hour));
    const summary = { requests: 0, statuses: {}, usage: {} };
    const byModel = new Map();
    for (const item of rollups) {
      summary.requests += item.requests || 0;
      for (const [status, count] of Object.entries(item.statuses || {})) {
        summary.statuses[status] = (summary.statuses[status] || 0) + count;
      }
      for (const [key, value] of Object.entries(item.usage || {})) {
        summary.usage[key] = (summary.usage[key] || 0) + value;
      }
      let model = byModel.get(item.model);
      if (!model) {
        model = { model: item.model, requests: 0, usage: {} };
        byModel.set(item.model, model);
      }
      model.requests += item.requests || 0;
      for (const [key, value] of Object.entries(item.usage || {})) {
        model.usage[key] = (model.usage[key] || 0) + value;
      }
    }
    return {
      enabled: this.enabled,
      range,
      summary,
      rollups,
      models: [...byModel.values()].sort((a, b) => b.requests - a.requests),
      requests: this.history.slice(-50).reverse()
    };
  }

  clearHistory() {
    return this.serializeWrite(() => {
      this.history = [];
      this.ensureDirectory();
      fs.writeFileSync(this.historyPath, '', { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(this.historyPath, 0o600);
      return { success: true };
    });
  }

  reset() {
    return this.serializeWrite(() => {
      this.history = [];
      this.rollups = [];
      this.ensureDirectory();
      fs.writeFileSync(this.historyPath, '', { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(this.historyPath, 0o600);
      this.writeJson(this.rollupsPath, this.rollups);
      return { success: true };
    });
  }
}

module.exports = UsageStatsStore;
