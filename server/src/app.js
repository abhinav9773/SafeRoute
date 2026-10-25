// HTTP API that exposes, but does not reimplement, the simulation engine.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { Link, Network, Node, Simulator, ValueError } from './engine.js';
import * as v from './validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_START = {
  topology: {
    nodes: [
      { id: 'hospital', name: 'Hospital', status: 'operational', type: 'hospital', x: 70, y: 170 },
      { id: 'router', name: 'Primary Router', status: 'operational', type: 'router', x: 300, y: 40 },
      { id: 'backup', name: 'Backup Router', status: 'operational', type: 'router', x: 300, y: 300 },
      { id: 'rescue', name: 'Rescue Center', status: 'operational', type: 'rescue', x: 530, y: 170 },
    ],
    links: [
      { id: 'hospital-router', source: 'hospital', destination: 'router', bandwidth: 1024, latency: 1, status: 'operational' },
      { id: 'router-rescue', source: 'router', destination: 'rescue', bandwidth: 1024, latency: 1, status: 'operational' },
      { id: 'hospital-backup', source: 'hospital', destination: 'backup', bandwidth: 1024, latency: 2, status: 'operational' },
      { id: 'backup-rescue', source: 'backup', destination: 'rescue', bandwidth: 1024, latency: 1, status: 'operational' },
    ],
  },
  tick_interval_seconds: 1.0,
  queue_capacity: 100,
  packet_bytes: 1024,
  packet_lifetime: 60,
  congestion_weight: 1.0,
};

const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];
const clone = (value) => structuredClone(value);

function buildSimulator(config) {
  if (!config.topology) throw new ValueError('a topology is required to create a simulation');
  const nodes = config.topology.nodes.map((n) => new Node(n.id, n.name || n.id, n.status, n.type, n.x, n.y));
  const links = config.topology.links.map((l) => new Link(l.id, l.source, l.destination, l.bandwidth, l.latency, l.status));
  return new Simulator(new Network(nodes, links), {
    queueCapacity: config.queue_capacity,
    packetBytes: config.packet_bytes,
    lifetime: config.packet_lifetime,
    congestionWeight: config.congestion_weight,
  });
}

export class SimulationManager {
  constructor(defaultConfig = DEFAULT_START) {
    this.config = clone(defaultConfig);
    this.simulator = buildSimulator(this.config);
    this.running = false;
    this.timer = null;
  }

  get status() { return this.running ? 'running' : 'paused'; }

  #stopClock() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  #startClock() {
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.simulator.step();
      this.timer = setTimeout(tick, this.config.tick_interval_seconds * 1000);
    };
    this.timer = setTimeout(tick, this.config.tick_interval_seconds * 1000);
  }

  start(request) {
    this.#stopClock();
    if (request) {
      const config = clone({ ...request, _present: undefined });
      if (!config.topology) config.topology = clone(this.config.topology);
      this.simulator = buildSimulator(config);
      this.config = config;
    }
    this.#startClock();
    return this.control('simulation running');
  }

  pause() { this.#stopClock(); return this.control('simulation paused'); }

  reset() {
    this.#stopClock();
    this.simulator = buildSimulator(this.config);
    return this.control('simulation reset');
  }

  shutdown() { this.#stopClock(); }

  control(message) {
    return { simulation_status: this.status, time: this.simulator.time, message };
  }

  topology() {
    const sim = this.simulator;
    const nodes = [...sim.network.nodes.values()].map((n) => ({ ...n }));
    const links = [...sim.network.links.values()].map((l) => ({
      ...l, utilization: l.utilization, queue: [...sim.linkQueues.get(l.id)],
    }));
    const packets = [...sim.packets.values()].map((p) => p.toJSON());
    const failures = [
      ...nodes.filter((n) => n.status === 'failed').map((n) => ({ component_type: 'node', component: n.id })),
      ...links.filter((l) => l.status === 'failed').map((l) => ({ component_type: 'link', component: l.id })),
    ];
    return {
      time: sim.time,
      simulation_status: this.status,
      nodes,
      links,
      active_routes: packets.filter((p) => p.status === 'queued' || p.status === 'in_flight').map((p) => ({
        packet: p.id, status: p.status, route: [...p.route], path: [...p.path],
        node: p.node, link: p.link, queued_link: p.queued_link,
      })),
      packets,
      failures,
      routing_changes: sim.events.filter((e) => e.kind === 'route_recalculated'),
    };
  }

  inject(request, traffic) {
    const made = [];
    for (let i = 0; i < request.count; i++) {
      made.push(this.simulator.inject(request.source, request.destination, traffic, { size: request.size }));
    }
    return made.map((p) => p.toJSON());
  }

  // Keep editor topology for reset while treating failures as run-time state.
  syncTopologyConfig() {
    const { network } = this.simulator;
    this.config.topology = {
      nodes: [...network.nodes.values()].map((n) => ({
        id: n.id, name: n.name, status: 'operational', type: n.type, x: n.x, y: n.y,
      })),
      links: [...network.links.values()].map((l) => ({
        id: l.id, source: l.source, destination: l.destination,
        bandwidth: l.bandwidth, latency: l.latency, status: 'operational',
      })),
    };
  }
}

const frontendOrigins = () => {
  const configured = process.env.FRONTEND_ORIGINS;
  if (configured === undefined) return DEFAULT_ORIGINS;
  return configured.split(',').map((o) => o.trim()).filter(Boolean);
};

export function createApp(defaultConfig = DEFAULT_START) {
  const manager = new SimulationManager(defaultConfig);
  const app = express();
  app.locals.manager = manager;
  app.use(cors({ origin: frontendOrigins(), methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
  app.use(express.json());

  // Wrap a handler: ValueError -> 404 (unknown ...) or 400, RequestError -> 422.
  const route = (handler, success = 200) => (req, res) => {
    try {
      res.status(success).json(handler(req));
    } catch (error) {
      if (error instanceof ValueError) {
        res.status(error.message.startsWith('unknown ') ? 404 : 400).json({ detail: error.message });
      } else if (error instanceof v.RequestError) {
        res.status(error.status).json({ detail: error.message });
      } else {
        console.error(error);
        res.status(500).json({ detail: 'internal server error' });
      }
    }
  };
  const network = () => manager.simulator.network;
  const edit = (operation) => route((req) => { operation(req); manager.syncTopologyConfig(); return manager.topology(); }, 200);

  app.get('/topology', route(() => manager.topology()));
  app.get('/metrics', route(() => manager.simulator.metrics()));
  app.get('/events', route((req) => {
    const since = req.query.since === undefined ? 0 : Number(req.query.since);
    const limit = req.query.limit === undefined ? 1000 : Number(req.query.limit);
    if (!Number.isInteger(since) || since < 0) throw new v.RequestError('"since" must be an integer of at least 0');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new v.RequestError('"limit" must be an integer from 1 to 10000');
    const events = clone(manager.simulator.events.slice(since, since + limit));
    return { count: events.length, events };
  }));

  app.post('/simulation/start', route((req) => {
    const hasBody = Number(req.headers['content-length'] ?? 0) > 0;
    return manager.start(hasBody ? v.startRequest(req.body) : null);
  }));
  app.post('/simulation/pause', route(() => manager.pause()));
  app.post('/simulation/reset', route(() => manager.reset()));

  app.post('/traffic/normal', route((req) => {
    const packets = manager.inject(v.trafficRequest(req.body), 'normal');
    return { accepted: packets.length, packets };
  }));
  app.post('/traffic/emergency', route((req) => {
    const body = v.emergencyRequest(req.body);
    const packets = manager.inject(body, body.service);
    return { accepted: packets.length, packets };
  }));

  app.post('/nodes', route((req) => {
    const n = v.nodeConfig(req.body);
    network().addNode(new Node(n.id, n.name || n.id, n.status, n.type, n.x, n.y));
    manager.syncTopologyConfig();
    return manager.topology();
  }, 201));
  app.patch('/nodes/:id', edit((req) => {
    const update = v.nodeUpdate(req.body);
    const current = network().nodes.get(req.params.id);
    if (!current) throw new ValueError('unknown node ID');
    network().updateNode(req.params.id, {
      name: update.name ?? current.name,
      type: update.type ?? current.type,
      x: update._present.has('x') ? update.x : current.x,
      y: update._present.has('y') ? update.y : current.y,
    });
  }));
  app.delete('/nodes/:id', edit((req) => network().removeNode(req.params.id)));
  app.post('/nodes/:id/fail', edit((req) => network().failNode(req.params.id)));
  app.post('/nodes/:id/recover', edit((req) => network().recoverNode(req.params.id)));

  app.post('/links', route((req) => {
    const l = v.linkConfig(req.body);
    network().addLink(new Link(l.id, l.source, l.destination, l.bandwidth, l.latency, l.status));
    manager.syncTopologyConfig();
    return manager.topology();
  }, 201));
  app.patch('/links/:id', edit((req) => {
    const update = v.linkUpdate(req.body);
    const current = network().links.get(req.params.id);
    if (!current) throw new ValueError('unknown link ID');
    network().updateLink(req.params.id, {
      bandwidth: update.bandwidth ?? current.bandwidth,
      latency: update.latency ?? current.latency,
    });
  }));
  app.delete('/links/:id', edit((req) => network().removeLink(req.params.id)));
  app.post('/links/:id/fail', edit((req) => network().failLink(req.params.id)));
  app.post('/links/:id/recover', edit((req) => network().recoverLink(req.params.id)));

  app.post('/disasters/trigger', route((req) => {
    const d = v.disasterRequest(req.body);
    const result = manager.simulator.triggerDisaster(d.disaster, d.intensity, { seed: d.seed });
    return { ...result, topology: manager.topology() };
  }));

  // Serve the built React dashboard from the same origin when it exists.
  // API routes above take precedence; this must stay last.
  const dist = process.env.FRONTEND_DIST || path.resolve(here, '../../frontend/dist');
  if (existsSync(path.join(dist, 'index.html'))) app.use(express.static(dist));

  // Malformed JSON bodies
  app.use((error, req, res, next) => {
    if (error?.type === 'entity.parse.failed') return res.status(422).json({ detail: 'request body is not valid JSON' });
    return next(error);
  });
  return { app, manager };
}
