import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Link, Network, Node, Simulator, ValueError } from '../src/engine.js';

const pair = (opts = {}) => new Simulator(new Network(['A', 'B'], [new Link('ab', 'A', 'B')]), opts);
const diamond = (weight = 0) => new Simulator(new Network(['A', 'B', 'C', 'D'], [
  new Link('ab', 'A', 'B'), new Link('bd', 'B', 'D'),
  new Link('ac', 'A', 'C', 1024, 2), new Link('cd', 'C', 'D'),
]), { congestionWeight: weight });
const EMERGENCY = ['hospital', 'police', 'fire', 'rescue', 'ambulance'];
const equal = assert.deepEqual;

describe('Network', () => {
  test('add named nodes and link', () => {
    const network = new Network();
    network.addNode(new Node('A', 'Hospital'));
    network.addNode(new Node('B', 'Rescue'));
    const link = network.addLink(new Link('radio', 'A', 'B', 500, 3));
    assert.equal(network.nodes.get('A').name, 'Hospital');
    assert.equal(network.nodes.get('A').status, 'operational');
    assert.equal(network.adjacency.get('A').get('B'), 'radio');
    assert.equal(network.adjacency.get('B').get('A'), 'radio');
    equal([link.bandwidth, link.latency, link.current_load], [500, 3, 0]);
    assert.equal(link.utilization, null);
  });

  test('fail and recover components', () => {
    const { network } = pair();
    network.failLink('ab');
    assert.equal(network.links.get('ab').status, 'failed');
    equal(network.route('A', 'B'), []);
    network.recoverLink('ab');
    network.failNode('B');
    equal(network.route('A', 'B'), []);
    equal(network.route('B', 'B'), []);
    network.recoverNode('B');
    equal(network.route('A', 'B'), ['A', 'B']);
  });

  test('add during simulation', () => {
    const sim = new Simulator(new Network(['A']));
    sim.network.addNode(new Node('B', 'Police'));
    sim.network.addLink(new Link('ab', 'A', 'B'));
    const packet = sim.inject('A', 'B');
    sim.step(2);
    assert.equal(packet.status, 'delivered');
  });

  test('independent runs do not share state', () => {
    const network = new Network([new Node('A', 'Hospital'), 'B'], [new Link('ab', 'A', 'B')]);
    const first = new Simulator(network);
    const second = new Simulator(network);
    first.network.failNode('A');
    equal(second.network.route('A', 'B'), ['A', 'B']);
    assert.equal(network.nodes.get('A').status, 'operational');
  });

  test('editor updates and topology deletion', () => {
    const sim = diamond();
    sim.network.updateNode('A', { name: 'Hospital', type: 'hospital', x: 25, y: 40 });
    const a = sim.network.nodes.get('A');
    equal([a.name, a.type, a.x, a.y], ['Hospital', 'hospital', 25, 40]);
    sim.network.updateLink('ab', { bandwidth: 2048, latency: 3 });
    equal([sim.network.links.get('ab').bandwidth, sim.network.links.get('ab').latency], [2048, 3]);
    const packet = sim.inject('A', 'D');
    equal(packet.route, ['A', 'C', 'D']);
    sim.network.removeLink('ac');
    equal(packet.route, ['A', 'B', 'D']);
    assert.ok(!sim.linkQueues.has('ac'));
    sim.network.removeNode('B');
    assert.equal(packet.status, 'dropped');
    assert.ok(!sim.network.nodes.has('B') && !sim.network.links.has('ab') && !sim.network.links.has('bd'));
  });

  test('deleting destination drops active packet', () => {
    const sim = pair();
    const packet = sim.inject('A', 'B');
    sim.network.removeNode('B');
    equal([packet.status, packet.drop_reason], ['dropped', 'endpoint_deleted']);
    equal(sim.queues.get('A'), []);
  });
});

describe('Routing', () => {
  test('Dijkstra weighted shortest path', () => {
    const sim = diamond();
    sim.network.addLink(new Link('ad', 'A', 'D', 1024, 10));
    equal(sim.network.route('A', 'D'), ['A', 'B', 'D']);
    equal(sim.network.route('D', 'A'), ['D', 'B', 'A']);
    equal(sim.network.route('A', 'A'), ['A']);
  });

  test('failed intermediate node and link are excluded', () => {
    const sim = diamond();
    sim.network.failNode('B');
    equal(sim.network.route('A', 'D'), ['A', 'C', 'D']);
    sim.network.failLink('cd');
    equal(sim.network.route('A', 'D'), []);
  });

  test('queued route recalculated after failure', () => {
    const sim = diamond();
    const packet = sim.inject('A', 'D');
    sim.network.failLink('ab');
    equal(packet.route, ['A', 'C', 'D']);
    sim.step(5);
    equal(packet.path, ['A', 'C', 'D']);
    assert.equal(packet.status, 'delivered');
  });

  test('failure after first hop reroutes through the sender', () => {
    const sim = diamond();
    const packet = sim.inject('A', 'D');
    sim.step(2);
    sim.network.failLink('bd');
    equal(packet.route, ['B', 'A', 'C', 'D']);
    sim.step(7);
    equal(packet.path, ['A', 'B', 'A', 'C', 'D']);
    assert.equal(packet.status, 'delivered');
  });

  test('congestion changes route', () => {
    const sim = diamond(1);
    for (let i = 0; i < 4; i++) sim.inject('A', 'D');
    sim.step();
    const transmissions = sim.events.filter((e) => e.kind === 'transmitted');
    equal(transmissions[0].route, ['A', 'C', 'D']);
  });
});

describe('Simulation', () => {
  test('packet fields and delivery', () => {
    const sim = pair();
    const packet = sim.generatePacket('A', 'B', { size: 512, priority: 'emergency' });
    equal([packet.id, packet.source, packet.destination, packet.size], [1, 'A', 'B', 512]);
    assert.equal(packet.priority, 'emergency');
    assert.equal(packet.creation_time, 0);
    assert.equal(packet.delivery_time, null);
    equal(packet.route, ['A', 'B']);
    sim.step();
    assert.equal(packet.status, 'in_flight');
    sim.step();
    assert.equal(packet.delivery_time, 2);
    assert.equal(packet.status, 'delivered');
  });

  for (const traffic of EMERGENCY) {
    test(`emergency priority: ${traffic}`, () => {
      const sim = pair();
      const normal = sim.inject('A', 'B');
      const emergency = sim.inject('A', 'B', traffic);
      sim.step();
      assert.equal(emergency.status, 'in_flight');
      assert.equal(normal.status, 'queued');
      sim.step(2);
      assert.ok(emergency.delivery_time < normal.delivery_time);
    });
  }

  test('shared bandwidth is FIFO in both directions', () => {
    const sim = pair();
    const first = sim.inject('B', 'A');
    const second = sim.inject('A', 'B');
    sim.step();
    assert.equal(first.status, 'in_flight');
    assert.equal(second.status, 'queued');
    assert.equal(sim.network.links.get('ab').current_load, 1024);
  });

  test('large packet serialization and non-preemption', () => {
    const sim = pair();
    const large = sim.inject('A', 'B', 'normal', { size: 2500 });
    sim.step();
    assert.equal(large.remaining_bytes, 1476);
    const urgent = sim.inject('B', 'A', 'normal', { size: 100, priority: 'emergency' });
    sim.step();
    assert.equal(large.remaining_bytes, 452);
    assert.equal(urgent.status, 'queued');
    sim.step();
    assert.equal(sim.network.links.get('ab').current_load, 552);
    sim.step();
    assert.equal(large.delivery_time, 4);
    assert.equal(urgent.delivery_time, 4);
    assert.equal(sim.network.links.get('ab').transmitted_bytes, 2600);
  });

  test('small packets share tick bandwidth', () => {
    const sim = pair();
    const packets = [1, 2, 3, 4].map(() => sim.inject('A', 'B', 'normal', { size: 256 }));
    sim.step(2);
    assert.ok(packets.every((p) => p.delivery_time === 2));
    assert.equal(sim.network.links.get('ab').transmitted_bytes, 1024);
  });

  test('unreachable is dropped and recovery allows new packets', () => {
    const sim = pair();
    sim.network.failNode('B');
    const packet = sim.inject('A', 'B');
    assert.equal(packet.drop_reason, 'unreachable');
    sim.step(2);
    assert.equal(sim.network.links.get('ab').utilization, null);
    sim.network.recoverNode('B');
    const fresh = sim.inject('A', 'B');
    sim.step(2);
    assert.equal(fresh.status, 'delivered');
    assert.equal(packet.status, 'dropped');
  });

  test('disconnection drops queued packet', () => {
    const sim = pair();
    const packet = sim.inject('A', 'B');
    sim.network.failLink('ab');
    assert.equal(packet.drop_reason, 'unreachable');
    equal(sim.queues.get('A'), []);
  });

  test('unreachable on arrival', () => {
    const sim = new Simulator(new Network(['A', 'B', 'C'], [new Link('ab', 'A', 'B'), new Link('bc', 'B', 'C')]));
    const packet = sim.inject('A', 'C');
    sim.step();
    sim.network.failLink('bc');
    sim.step();
    equal(packet.path, ['A', 'B']);
    assert.equal(packet.drop_reason, 'unreachable');
  });

  for (const component of ['node', 'link']) {
    for (const size of [512, 5000]) {
      test(`in-flight ${component} failure and restore (size ${size})`, () => {
        const sim = pair();
        const packet = sim.inject('A', 'B', 'normal', { size });
        sim.step();
        if (component === 'node') { sim.network.failNode('A'); sim.network.recoverNode('A'); }
        else { sim.network.failLink('ab'); sim.network.recoverLink('ab'); }
        assert.equal(packet.drop_reason, `${component}_failed`);
        const fresh = sim.inject('A', 'B');
        sim.step(2);
        assert.equal(fresh.status, 'delivered');
        assert.equal(packet.status, 'dropped');
      });
    }
  }

  test('queue overflow and node failure', () => {
    const sim = pair({ queueCapacity: 1 });
    const first = sim.inject('A', 'B');
    assert.equal(sim.inject('A', 'B').drop_reason, 'queue_overflow');
    sim.network.failNode('A');
    assert.equal(first.drop_reason, 'node_failed');
    assert.equal(sim.inject('A', 'B').drop_reason, 'source_failed');
  });

  test('lifetime expiry in queue', () => {
    const sim = pair({ lifetime: 1 });
    const first = sim.inject('A', 'B');
    const second = sim.inject('A', 'B');
    sim.step();
    assert.equal(first.drop_reason, 'lifetime_expired');
    assert.equal(second.drop_reason, 'lifetime_expired');
  });

  test('local delivery', () => {
    const sim = pair();
    assert.equal(sim.inject('A', 'A').status, 'delivered');
    assert.equal(sim.metrics().average_latency_seconds, 0);
    assert.equal(sim.network.links.get('ab').transmitted_bytes, 0);
  });

  test('disaster presets fail real components deterministically', () => {
    const nodes = [new Node('R1', 'Router 1', 'operational', 'router', 0, 0), new Node('R2', 'Router 2', 'operational', 'router', 10, 0),
      new Node('H', 'Hospital', 'operational', 'hospital', 100, 100), new Node('P', 'Police', 'operational', 'police', 110, 100)];
    const links = [new Link('r1-r2', 'R1', 'R2'), new Link('r1-h', 'R1', 'H'), new Link('r2-p', 'R2', 'P'), new Link('h-p', 'H', 'P')];
    const run = (kind) => {
      const sim = new Simulator(new Network(nodes, links));
      const result = sim.triggerDisaster(kind, 'medium', { seed: 7 });
      result.failed_nodes.forEach((id) => assert.equal(sim.network.nodes.get(id).status, 'failed'));
      result.failed_links.forEach((id) => assert.equal(sim.network.links.get(id).status, 'failed'));
      assert.equal(sim.events[0].kind, 'disaster_triggered');
      assert.equal(sim.events.at(-1).kind, 'recalculating_routes');
      return result;
    };
    for (const kind of ['earthquake', 'flood', 'cyclone', 'cyberattack']) equal(run(kind), run(kind));
    const cyber = run('cyberattack');
    assert.ok(cyber.failed_nodes.length > 0);
    assert.ok(cyber.failed_nodes.every((id) => ['R1', 'R2'].includes(id)));
  });
});

describe('Metrics', () => {
  test('exact variable-size metrics', () => {
    const sim = pair({ queueCapacity: 2 });
    sim.inject('A', 'B', 'normal', { size: 512 });
    sim.inject('A', 'B', 'normal', { size: 1024 });
    sim.inject('A', 'B'); // queue overflow
    sim.step(3);
    const m = sim.metrics();
    assert.equal(m.average_latency_seconds, 2.5);
    assert.equal(m.throughput_bps, 4096);
    assert.ok(Math.abs(m.packet_loss_percentage - 100 / 3) < 1e-9);
    assert.equal(m.links.ab.utilization, 0.5);
    assert.equal(m.pending, 0);
    assert.equal(m.links.ab.last_tick_utilization, 0);
  });

  test('failure keeps consumed bytes in utilization', () => {
    const sim = pair();
    sim.inject('A', 'B', 'normal', { size: 3000 });
    sim.step();
    sim.network.failLink('ab');
    sim.step(2);
    assert.equal(sim.network.links.get('ab').transmitted_bytes, 1024);
    assert.equal(sim.network.links.get('ab').available_bytes, 1024);
    assert.equal(sim.metrics().packet_loss_percentage, 100);
    assert.equal(sim.metrics().throughput_bps, 0);
    assert.equal(sim.metrics().links.ab.last_tick_utilization, null);
  });

  test('snapshots are copies and empty metrics are sane', () => {
    const sim = pair();
    assert.equal(sim.metrics().average_latency_seconds, null);
    assert.equal(sim.metrics().throughput_bps, 0);
    assert.equal(sim.metrics().packet_loss_percentage, 0);
    sim.inject('A', 'B');
    sim.step();
    const snapshot = sim.snapshot();
    JSON.stringify(snapshot);
    snapshot.nodes.A.name = 'changed';
    snapshot.packets[0].path.length = 0;
    snapshot.events[1].route.length = 0;
    assert.equal(sim.network.nodes.get('A').name, 'A');
    equal(sim.packets.get(1).path, ['A']);
    equal(sim.events[1].route, ['A', 'B']);
  });

  test('packet conservation, capacity and determinism', () => {
    const run = () => {
      const sim = diamond(1);
      for (let tick = 0; tick < 30; tick++) {
        sim.inject('A', 'D', tick % 3 === 0 ? 'rescue' : 'normal', { size: 300 + tick * 100 });
        if (tick === 5) sim.network.failNode('B');
        if (tick === 12) sim.network.recoverNode('B');
        sim.step();
        const m = sim.metrics();
        assert.equal(m.injected, m.delivered + m.dropped + m.pending);
        for (const link of sim.network.links.values()) {
          assert.ok(link.current_load <= link.last_available_bytes);
          assert.ok(link.transmitted_bytes <= link.available_bytes);
        }
      }
      return sim.snapshot();
    };
    equal(run(), run());
  });
});

describe('Validation', () => {
  test('invalid topology and atomic add', () => {
    const factories = [() => new Node('', 'Name'), () => new Node('A', ''), () => new Node('A', 'Name', 'broken'),
      () => new Link('x', 'A', 'A'), () => new Link('x', 'A', 'B', 0), () => new Link('x', 'A', 'B', 1024, true),
      () => new Network(['A', 'A'])];
    for (const make of factories) assert.throws(make, ValueError);
    const { network } = pair();
    const before = [...network.adjacency.get('A')];
    for (const link of [new Link('x', 'A', 'C'), new Link('other', 'B', 'A')]) assert.throws(() => network.addLink(link), ValueError);
    equal([...network.adjacency.get('A')], before);
    assert.equal(network.links.size, 1);
  });

  test('invalid controls do not mutate', () => {
    const sim = pair();
    const bad = [{ size: 0 }, { size: true }, { priority: 'urgent' }, { traffic: 'unknown' }, { traffic: 'hospital', priority: 'normal' }];
    for (const { traffic = 'normal', ...rest } of bad) assert.throws(() => sim.inject('A', 'B', traffic, rest), ValueError);
    assert.throws(() => sim.inject('A', 'unknown'), ValueError);
    assert.equal(sim.metrics().injected, 0);
    for (const ticks of [0, -1, 1.5, true]) assert.throws(() => sim.step(ticks), ValueError);
    assert.throws(() => pair({ congestionWeight: NaN }), ValueError);
    for (const control of ['failNode', 'recoverNode', 'failLink', 'recoverLink']) {
      assert.throws(() => sim.network[control]('unknown'), ValueError);
    }
    assert.throws(() => sim.setNodeActive('A', 1), ValueError);
    assert.throws(() => sim.network.route('A', 'B', { ab: -1 }), ValueError);
  });
});
