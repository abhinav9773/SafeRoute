import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createApp } from '../src/app.js';

const TOPOLOGY = {
  nodes: [{ id: 'A', name: 'Hospital' }, { id: 'B', name: 'Primary Router' }, { id: 'C', name: 'Backup Router' }, { id: 'D', name: 'Rescue Center' }],
  links: [
    { id: 'ab', source: 'A', destination: 'B', bandwidth: 1024 }, { id: 'bd', source: 'B', destination: 'D', bandwidth: 1024 },
    { id: 'ac', source: 'A', destination: 'C', bandwidth: 1024, latency: 2 }, { id: 'cd', source: 'C', destination: 'D', bandwidth: 1024 },
  ],
};
const equal = assert.deepEqual;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server, manager, base;
beforeEach(async () => {
  const created = createApp();
  manager = created.manager;
  server = created.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  manager.shutdown();
  await new Promise((r) => server.close(r));
});

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
};
const get = (p) => call('GET', p);
const post = (p, b) => call('POST', p, b);
const startTest = async (tick = 60) => {
  const r = await post('/simulation/start', { topology: TOPOLOGY, tick_interval_seconds: tick, queue_capacity: 20, packet_lifetime: 100, congestion_weight: 0 });
  assert.equal(r.status, 200);
  return r.body;
};

describe('API', () => {
  test('default topology exposes frontend state and CORS works', async () => {
    const { status, body: t } = await get('/topology');
    assert.equal(status, 200);
    assert.equal(t.simulation_status, 'paused');
    assert.equal(t.time, 0);
    equal([t.nodes.length, t.links.length], [4, 4]);
    for (const key of ['active_routes', 'packets', 'failures', 'routing_changes']) equal(t[key], []);
    assert.ok(t.nodes.every((n) => 'status' in n));
    assert.ok(t.links.every((l) => 'status' in l && 'queue' in l));
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:4173']) {
      const res = await fetch(`${base}/topology`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
      assert.equal(res.headers.get('access-control-allow-origin'), origin);
    }
  });

  test('start, clock, pause and reset', async () => {
    const started = await startTest(0.01);
    assert.equal(started.simulation_status, 'running');
    const deadline = Date.now() + 1500;
    let metrics = (await get('/metrics')).body;
    while (metrics.elapsed_seconds < 2 && Date.now() < deadline) { await sleep(10); metrics = (await get('/metrics')).body; }
    assert.ok(metrics.elapsed_seconds >= 2);
    const paused = (await post('/simulation/pause')).body;
    assert.equal(paused.simulation_status, 'paused');
    await sleep(40);
    assert.equal((await get('/metrics')).body.elapsed_seconds, paused.time);
    await post('/traffic/normal', { source: 'A', destination: 'D' });
    equal((await post('/simulation/reset')).body, { simulation_status: 'paused', time: 0, message: 'simulation reset' });
    equal((await get('/topology')).body.packets, []);
  });

  test('start without a body resumes the current simulation', async () => {
    await startTest();
    await post('/traffic/normal', { source: 'A', destination: 'D' });
    await post('/simulation/pause');
    const resumed = await post('/simulation/start');
    assert.equal(resumed.body.simulation_status, 'running');
    assert.equal((await get('/topology')).body.packets.length, 1);
  });

  test('normal and emergency traffic update state and metrics', async () => {
    await startTest();
    const normal = await post('/traffic/normal', { source: 'A', destination: 'D', size: 512, count: 2 });
    const emergency = await post('/traffic/emergency', { source: 'A', destination: 'D', size: 256, service: 'ambulance' });
    assert.equal(normal.status, 200);
    assert.equal(normal.body.accepted, 2);
    assert.ok(normal.body.packets.every((p) => p.packet_class === 'normal'));
    assert.equal(emergency.body.packets[0].packet_class, 'emergency');
    assert.equal(emergency.body.packets[0].traffic, 'ambulance');
    const t = (await get('/topology')).body;
    equal([t.packets.length, t.active_routes.length], [3, 3]);
    equal(t.links.find((l) => l.id === 'ab').queue, [1, 2, 3]);
    const m = (await get('/metrics')).body;
    assert.equal(m.packets_generated, 3);
    assert.equal(m.traffic_classes.normal.generated, 2);
    assert.equal(m.traffic_classes.emergency.generated, 1);
    assert.equal(m.links.ab.queue_depth, 3);
    const events = (await get('/events')).body;
    assert.equal(events.count, 6);
    equal(events.events.map((e) => e.kind), ['injected', 'queued', 'injected', 'queued', 'injected', 'queued']);
  });

  test('link failure reroutes and recovery restores the primary route', async () => {
    await startTest();
    const packet = (await post('/traffic/normal', { source: 'A', destination: 'D' })).body.packets[0];
    equal(packet.route, ['A', 'B', 'D']);
    const failed = await post('/links/ab/fail');
    assert.equal(failed.status, 200);
    assert.ok(failed.body.failures.some((f) => f.component_type === 'link' && f.component === 'ab'));
    equal(failed.body.active_routes[0].route, ['A', 'C', 'D']);
    assert.equal(failed.body.routing_changes.at(-1).reason, 'link_failed');
    const recovered = (await post('/links/ab/recover')).body;
    equal(recovered.failures, []);
    equal(recovered.active_routes[0].route, ['A', 'B', 'D']);
    assert.equal(recovered.routing_changes.at(-1).reason, 'link_restored');
  });

  test('node failure, recovery and event pagination', async () => {
    await startTest();
    await post('/traffic/emergency', { source: 'A', destination: 'D', service: 'rescue' });
    const failed = await post('/nodes/B/fail');
    assert.equal(failed.status, 200);
    assert.ok(failed.body.failures.some((f) => f.component === 'B'));
    equal([failed.body.nodes.length, failed.body.links.length], [4, 4]);
    assert.equal(failed.body.nodes.find((n) => n.id === 'B').status, 'failed');
    equal(failed.body.active_routes[0].route, ['A', 'C', 'D']);
    assert.equal((await post('/nodes/B/recover')).body.failures.length, 0);
    const page = await get('/events?since=2&limit=2');
    assert.equal(page.body.count, 2);
    assert.equal(page.body.events[0].kind, 'node_failed');
  });

  test('invalid components, endpoints and bodies are rejected', async () => {
    await startTest();
    for (const path of ['/nodes/missing/fail', '/nodes/missing/recover', '/links/missing/fail', '/links/missing/recover']) {
      const r = await post(path);
      assert.equal(r.status, 404);
      assert.match(r.body.detail, /unknown/);
    }
    const unknown = await post('/traffic/normal', { source: 'missing', destination: 'D' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.detail, 'unknown packet endpoint');
    assert.equal((await post('/traffic/emergency', { source: 'A', destination: 'D', service: 'vip', count: 0 })).status, 422);
    assert.equal((await post('/traffic/normal', { source: 'A', destination: 'D', fake_latency: 1 })).status, 422);
  });

  test('topology editor CRUD, and reset preserves the edited graph', async () => {
    const created = await post('/nodes', { id: 'police-1', name: 'Police Station 1', type: 'police', x: 125, y: 240 });
    assert.equal(created.status, 201);
    const police = created.body.nodes.find((n) => n.id === 'police-1');
    equal([police.type, police.x, police.y], ['police', 125, 240]);
    const link = await post('/links', { id: 'police-router', source: 'police-1', destination: 'router', bandwidth: 4096, latency: 2 });
    assert.equal(link.status, 201);
    const updated = await call('PATCH', '/links/police-router', { bandwidth: 8192, latency: 3 });
    const edited = updated.body.links.find((l) => l.id === 'police-router');
    equal([edited.bandwidth, edited.latency], [8192, 3]);
    const moved = await call('PATCH', '/nodes/police-1', { x: 300, y: 90 });
    const node = moved.body.nodes.find((n) => n.id === 'police-1');
    equal([node.x, node.y], [300, 90]);
    await post('/nodes/police-1/fail');
    await post('/simulation/reset');
    const state = (await get('/topology')).body;
    assert.equal(state.nodes.find((n) => n.id === 'police-1').status, 'operational');
    assert.ok(state.links.some((l) => l.id === 'police-router'));
    const delLink = await call('DELETE', '/links/police-router');
    assert.equal(delLink.status, 200);
    assert.ok(!delLink.body.links.some((l) => l.id === 'police-router'));
    const delNode = await call('DELETE', '/nodes/police-1');
    assert.ok(!delNode.body.nodes.some((n) => n.id === 'police-1'));
  });

  test('disaster endpoint mutates the engine and records events', async () => {
    await startTest();
    const r = await post('/disasters/trigger', { disaster: 'earthquake', intensity: 'medium', seed: 11 });
    assert.equal(r.status, 200);
    assert.ok(r.body.failed_nodes.length && r.body.failed_links.length);
    const failed = new Set(r.body.topology.failures.map((f) => `${f.component_type}:${f.component}`));
    assert.ok(r.body.failed_nodes.every((id) => failed.has(`node:${id}`)));
    assert.ok(r.body.failed_links.every((id) => failed.has(`link:${id}`)));
    const kinds = (await get('/events')).body.events.map((e) => e.kind);
    assert.equal(kinds[0], 'disaster_triggered');
    assert.equal(kinds.at(-1), 'recalculating_routes');
    assert.equal((await post('/disasters/trigger', { disaster: 'meteor', intensity: 'extreme' })).status, 422);
  });
});
