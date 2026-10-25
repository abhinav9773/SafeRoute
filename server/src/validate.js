// Small request validators mirroring the original API schemas (unknown fields are rejected).

export class RequestError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

const HEALTH = ['operational', 'failed'];
const NODE_TYPES = ['router', 'switch', 'hospital', 'police', 'fire', 'rescue', 'ambulance'];
const SERVICES = ['emergency', 'hospital', 'ambulance', 'police', 'fire', 'rescue'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// rules: { field: { type, required, nullable, default, min, gt, ge, le, oneOf } }
export function parse(body, rules, label = 'request') {
  if (!isObject(body)) throw new RequestError(`${label} must be a JSON object`);
  for (const key of Object.keys(body)) {
    if (!(key in rules)) throw new RequestError(`${label}: unexpected field "${key}"`);
  }
  const out = {};
  const present = new Set();
  for (const [field, rule] of Object.entries(rules)) {
    let value = body[field];
    if (value === undefined) {
      if (rule.required) throw new RequestError(`${label}: "${field}" is required`);
      out[field] = rule.default === undefined ? null : rule.default;
      continue;
    }
    present.add(field);
    if (value === null) {
      if (!rule.nullable) throw new RequestError(`${label}: "${field}" must not be null`);
      out[field] = null;
      continue;
    }
    const bad = (why) => new RequestError(`${label}: "${field}" ${why}`);
    switch (rule.type) {
      case 'string':
        if (typeof value !== 'string') throw bad('must be a string');
        if (value.length < 1) throw bad('must not be empty');
        break;
      case 'int':
        if (typeof value !== 'number' || !Number.isInteger(value)) throw bad('must be an integer');
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('must be a finite number');
        break;
      default:
        break;
    }
    if (rule.gt !== undefined && !(value > rule.gt)) throw bad(`must be greater than ${rule.gt}`);
    if (rule.ge !== undefined && !(value >= rule.ge)) throw bad(`must be at least ${rule.ge}`);
    if (rule.le !== undefined && !(value <= rule.le)) throw bad(`must be at most ${rule.le}`);
    if (rule.oneOf && !rule.oneOf.includes(value)) throw bad(`must be one of: ${rule.oneOf.join(', ')}`);
    out[field] = value;
  }
  out._present = present;
  return out;
}

const nodeRules = {
  id: { type: 'string', required: true },
  name: { type: 'string', nullable: true },
  status: { type: 'string', oneOf: HEALTH, default: 'operational' },
  type: { type: 'string', oneOf: NODE_TYPES, default: 'router' },
  x: { type: 'number', nullable: true },
  y: { type: 'number', nullable: true },
};
const linkRules = {
  id: { type: 'string', required: true },
  source: { type: 'string', required: true },
  destination: { type: 'string', required: true },
  bandwidth: { type: 'int', gt: 0, default: 1024 },
  latency: { type: 'int', gt: 0, default: 1 },
  status: { type: 'string', oneOf: HEALTH, default: 'operational' },
};

export const nodeConfig = (b) => parse(b, nodeRules, 'node');
export const linkConfig = (b) => parse(b, linkRules, 'link');

export function topologyConfig(b) {
  if (!isObject(b)) throw new RequestError('topology must be a JSON object');
  const parsed = parse(b, { nodes: { default: [] }, links: { default: [] } }, 'topology');
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.links)) {
    throw new RequestError('topology: nodes and links must be arrays');
  }
  return { nodes: parsed.nodes.map(nodeConfig), links: parsed.links.map(linkConfig) };
}

export const nodeUpdate = (b) => parse(b, {
  name: { type: 'string', nullable: true },
  type: { type: 'string', oneOf: NODE_TYPES, nullable: true },
  x: { type: 'number', nullable: true },
  y: { type: 'number', nullable: true },
}, 'node update');

export const linkUpdate = (b) => parse(b, {
  bandwidth: { type: 'int', gt: 0, nullable: true },
  latency: { type: 'int', gt: 0, nullable: true },
}, 'link update');

export const disasterRequest = (b) => parse(b, {
  disaster: { type: 'string', required: true, oneOf: ['earthquake', 'flood', 'cyclone', 'cyberattack'] },
  intensity: { type: 'string', oneOf: ['low', 'medium', 'high'], default: 'medium' },
  seed: { type: 'int', default: 0 },
}, 'disaster');

export function startRequest(b) {
  const parsed = parse(b, {
    topology: { nullable: true },
    tick_interval_seconds: { type: 'number', gt: 0, default: 1.0 },
    queue_capacity: { type: 'int', gt: 0, default: 100 },
    packet_bytes: { type: 'int', gt: 0, default: 1024 },
    packet_lifetime: { type: 'int', gt: 0, default: 60 },
    congestion_weight: { type: 'number', ge: 0, default: 1.0 },
  }, 'simulation settings');
  parsed.topology = parsed.topology === null ? null : topologyConfig(parsed.topology);
  return parsed;
}

const trafficRules = {
  source: { type: 'string', required: true },
  destination: { type: 'string', required: true },
  size: { type: 'int', gt: 0, nullable: true },
  count: { type: 'int', ge: 1, le: 1000, default: 1 },
};
export const trafficRequest = (b) => parse(b, trafficRules, 'traffic');
export const emergencyRequest = (b) => parse(b, {
  ...trafficRules,
  service: { type: 'string', oneOf: SERVICES, default: 'emergency' },
}, 'emergency traffic');
