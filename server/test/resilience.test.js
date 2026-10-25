import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Link, Network, Simulator } from '../src/engine.js';

const equal = assert.deepEqual;

describe('Traffic priority', () => {
  test('emergency packet overtakes normal packets on a congested link', () => {
    const sim = new Simulator(new Network(['source', 'destination'], [new Link('bottleneck', 'source', 'destination', 1024)]),
      { queueCapacity: 10, congestionWeight: 0 });
    const normal = [1, 2, 3, 4, 5].map(() => sim.inject('source', 'destination', 'normal', { size: 1024 }));
    sim.step();
    const emergency = sim.inject('source', 'destination', 'ambulance', { size: 1024 });
    equal(sim.linkQueues.get('bottleneck'), [2, 3, 4, 5, emergency.id]);
    sim.step();
    const transmissions = sim.events.filter((e) => e.kind === 'transmitted');
    equal(transmissions.slice(0, 2).map((e) => e.packet), [normal[0].id, emergency.id]);
    assert.equal(transmissions[1].priority, 'emergency');
    assert.ok(normal.slice(1).every((p) => p.status === 'queued'));
    while ([...normal, emergency].some((p) => p.status === 'queued' || p.status === 'in_flight')) sim.step();
    assert.equal(emergency.packet_class, 'emergency');
    assert.equal(emergency.latency_seconds, 2);
    assert.ok(normal.slice(1).every((p) => emergency.delivery_time < p.delivery_time));
    const m = sim.metrics();
    equal([m.packets_generated, m.packets_delivered, m.packets_dropped], [6, 6, 0]);
    assert.equal(m.emergency_packet_latency_seconds, 2);
    assert.equal(m.normal_packet_latency_seconds, 4.8);
    assert.ok(Math.abs(m.throughput_bps - (6 * 1024 * 8) / 7) < 1e-6);
    assert.ok(Math.abs(m.links.bottleneck.utilization - 6 / 7) < 1e-9);
    equal(m.traffic_classes.emergency, { generated: 1, delivered: 1, dropped: 0, pending: 0, average_latency_seconds: 2 });
  });

  for (const service of ['EMERGENCY', 'hospital', 'ambulance', 'police', 'fire', 'rescue']) {
    test(`traffic "${service}" maps to the emergency class`, () => {
      const sim = new Simulator(new Network(['A', 'B'], [new Link('ab', 'A', 'B')]));
      const packet = sim.inject('A', 'B', service);
      assert.equal(packet.packet_class, 'emergency');
      equal(sim.linkQueues.get('ab'), [packet.id]);
    });
  }
});

const resilient = () => new Simulator(new Network(['S', 'A', 'B', 'C', 'D'], [
  new Link('sa', 'S', 'A', 4096, 1), new Link('ad', 'A', 'D', 4096, 1),
  new Link('sb', 'S', 'B', 4096, 2), new Link('bd', 'B', 'D', 4096, 2),
  new Link('sc', 'S', 'C', 4096, 3), new Link('cd', 'C', 'D', 4096, 3),
  new Link('ab', 'A', 'B', 4096, 1),
]), { congestionWeight: 0 });

const untilDone = (sim, ids) => {
  for (let i = 0; i < 30; i++) {
    if (ids.every((id) => ['delivered', 'dropped'].includes(sim.packets.get(id).status))) return;
    sim.step();
  }
  assert.fail('packets did not terminate within 30 ticks');
};
const routeEvents = (sim, id) => sim.events.filter((e) => e.kind === 'route_recalculated' && e.packet === id);
const transmittedLinks = (sim, id) => sim.events.filter((e) => e.kind === 'transmitted' && e.packet === id).map((e) => e.link);

describe('Disaster resilience', () => {
  test('normal network delivers on the shortest route', () => {
    const sim = resilient();
    const packets = [1, 2, 3].map(() => sim.inject('S', 'D', 'normal', { size: 256 }));
    untilDone(sim, packets.map((p) => p.id));
    assert.ok(packets.every((p) => p.status === 'delivered'));
    assert.ok(packets.every((p) => p.path.join() === 'S,A,D'));
    assert.equal(sim.metrics().dropped, 0);
  });

  test('link failure reroutes and never uses the failed link', () => {
    const sim = resilient();
    const packet = sim.inject('S', 'D', 'normal', { size: 256 });
    sim.step(2);
    equal(packet.route, ['A', 'D']);
    sim.network.failLink('ad');
    equal(packet.route, ['A', 'B', 'D']);
    const change = routeEvents(sim, packet.id).at(-1);
    equal(change.previous_route, ['A', 'D']);
    equal(change.route, ['A', 'B', 'D']);
    equal([change.reason, change.component], ['link_failed', 'ad']);
    untilDone(sim, [packet.id]);
    assert.ok(!transmittedLinks(sim, packet.id).includes('ad'));
    equal(packet.path, ['S', 'A', 'B', 'D']);
    assert.equal(packet.status, 'delivered');
  });

  test('node failure excludes the router and uses an alternate route', () => {
    const sim = resilient();
    const packet = sim.inject('S', 'D', 'normal', { size: 256 });
    equal(packet.route, ['S', 'A', 'D']);
    sim.network.failNode('A');
    equal(packet.route, ['S', 'B', 'D']);
    const change = routeEvents(sim, packet.id).at(-1);
    equal([change.reason, change.component], ['node_failed', 'A']);
    untilDone(sim, [packet.id]);
    assert.ok(!packet.path.includes('A'));
    equal(packet.path, ['S', 'B', 'D']);
    assert.equal(packet.status, 'delivered');
  });

  test('multiple link failures keep a connected graph routable', () => {
    const sim = resilient();
    const packet = sim.inject('S', 'D', 'normal', { size: 256 });
    sim.network.failLink('ad');
    sim.network.failLink('bd');
    equal(sim.network.route('S', 'D'), ['S', 'C', 'D']);
    equal(routeEvents(sim, packet.id).map((e) => e.route), [['S', 'B', 'D'], ['S', 'C', 'D']]);
    untilDone(sim, [packet.id]);
    const used = new Set(transmittedLinks(sim, packet.id));
    assert.ok(!used.has('ad') && !used.has('bd'));
    equal(packet.path, ['S', 'C', 'D']);
  });

  test('network partition drops the packet as unreachable', () => {
    const sim = resilient();
    const packet = sim.inject('S', 'D', 'normal', { size: 256 });
    ['ad', 'bd', 'cd'].forEach((id) => sim.network.failLink(id));
    equal(sim.network.route('S', 'D'), []);
    assert.equal(packet.status, 'dropped');
    assert.equal(packet.drop_reason, 'unreachable');
    const change = routeEvents(sim, packet.id).at(-1);
    equal(change.previous_route, ['S', 'C', 'D']);
    equal(change.route, []);
    assert.equal(change.reason, 'link_failed');
    assert.ok(sim.events.some((e) => e.kind === 'dropped' && e.packet === packet.id && e.reason === 'unreachable'));
  });

  for (const [kind, id] of [['link', 'ad'], ['node', 'A']]) {
    test(`recovered ${kind} becomes usable again`, () => {
      const sim = resilient();
      const packet = sim.inject('S', 'D', 'normal', { size: 256 });
      if (kind === 'link') sim.network.failLink(id); else sim.network.failNode(id);
      equal(packet.route, ['S', 'B', 'D']);
      if (kind === 'link') sim.network.recoverLink(id); else sim.network.recoverNode(id);
      equal(packet.route, ['S', 'A', 'D']);
      const event = routeEvents(sim, packet.id).at(-1);
      assert.equal(event.reason, `${kind}_restored`);
      assert.equal(event.component, id);
      untilDone(sim, [packet.id]);
      equal(packet.path, ['S', 'A', 'D']);
      assert.equal(packet.status, 'delivered');
      if (kind === 'link') assert.ok(sim.network.links.get(id).transmitted_bytes > 0);
    });
  }
});
