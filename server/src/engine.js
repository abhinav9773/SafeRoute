// Deterministic graph routing and store-and-forward packet simulation.
// One tick is one simulated second. Sizes and bandwidth use bytes and bytes/second.

export class ValueError extends Error {}

const positiveInteger = (value, name) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ValueError(`${name} must be a positive integer`);
  }
};
const validId = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw new ValueError('IDs must be nonempty strings');
};
const validStatus = (status) => {
  if (status !== 'operational' && status !== 'failed') throw new ValueError('status must be operational or failed');
};
export const NODE_TYPES = new Set(['router', 'switch', 'hospital', 'police', 'fire', 'rescue', 'ambulance']);
const validNodeType = (type) => {
  if (!NODE_TYPES.has(type)) throw new ValueError('unknown node type');
};
const validCoordinate = (value, name) => {
  if (value !== null && value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new ValueError(`${name} must be a finite number or null`);
  }
};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Python-style round(): halves go to the nearest even integer.
const pyRound = (x) => {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
};

// Small seeded generator (mulberry32) so disaster presets are reproducible.
function seededRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    choice: (items) => items[Math.floor(next() * items.length)],
    sample(items, count) {
      const pool = [...items];
      for (let i = 0; i < count; i++) {
        const j = i + Math.floor(next() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, count);
    },
  };
}

// Minimal binary min-heap ordered by (distance, node id).
class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  less(a, b) { return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]); }
  push(item) {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(items[i], items[parent])) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < items.length && this.less(items[l], items[m])) m = l;
        if (r < items.length && this.less(items[r], items[m])) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m], items[i]];
        i = m;
      }
    }
    return top;
  }
}

export class Node {
  constructor(id, name, status = 'operational', type = 'router', x = null, y = null) {
    this.id = id; this.name = name; this.status = status; this.type = type;
    this.x = x ?? null; this.y = y ?? null;
    validId(this.id); validId(this.name); validStatus(this.status); validNodeType(this.type);
    validCoordinate(this.x, 'x'); validCoordinate(this.y, 'y');
  }
}

export class Link {
  constructor(id, source, destination, bandwidth = 1024, latency = 1, status = 'operational') {
    this.id = id; this.source = source; this.destination = destination;
    this.bandwidth = bandwidth; this.latency = latency; this.status = status;
    this.current_load = 0; this.transmitted_bytes = 0;
    this.available_bytes = 0; this.last_available_bytes = 0;
    [id, source, destination].forEach(validId);
    if (source === destination) throw new ValueError('link endpoints must be distinct');
    positiveInteger(bandwidth, 'bandwidth');
    positiveInteger(latency, 'latency');
    validStatus(status);
  }
  get utilization() {
    return this.available_bytes ? this.transmitted_bytes / this.available_bytes : null;
  }
}

export class Network {
  constructor(nodes = [], links = []) {
    this.nodes = new Map();
    this.links = new Map();
    this.adjacency = new Map();
    this.onChange = null;
    nodes.forEach((node) => this.addNode(node));
    links.forEach((link) => this.addLink(link));
  }

  addNode(node) {
    node = typeof node === 'string'
      ? new Node(node, node)
      : new Node(node.id, node.name, node.status, node.type, node.x, node.y);
    if (this.nodes.has(node.id)) throw new ValueError('duplicate node ID');
    this.nodes.set(node.id, node);
    this.adjacency.set(node.id, new Map());
    this.#notify('node_added', node.id);
    return node;
  }

  addLink(link) {
    link = new Link(link.id, link.source, link.destination, link.bandwidth, link.latency, link.status);
    if (this.links.has(link.id)) throw new ValueError('duplicate link ID');
    if (!this.nodes.has(link.source) || !this.nodes.has(link.destination)) throw new ValueError('unknown link endpoint');
    if (this.adjacency.get(link.source).has(link.destination)) throw new ValueError('parallel links are not supported');
    this.links.set(link.id, link);
    this.adjacency.get(link.source).set(link.destination, link.id);
    this.adjacency.get(link.destination).set(link.source, link.id);
    this.#notify('link_added', link.id);
    return link;
  }

  updateNode(nodeId, { name, type, x, y }) {
    if (!this.nodes.has(nodeId)) throw new ValueError('unknown node ID');
    const node = this.nodes.get(nodeId);
    const candidate = new Node(nodeId, name, node.status, type, x, y);
    Object.assign(node, { name: candidate.name, type: candidate.type, x: candidate.x, y: candidate.y });
    this.#notify('node_updated', nodeId);
    return node;
  }

  updateLink(linkId, { bandwidth, latency }) {
    if (!this.links.has(linkId)) throw new ValueError('unknown link ID');
    const link = this.links.get(linkId);
    const candidate = new Link(link.id, link.source, link.destination, bandwidth, latency, link.status);
    link.bandwidth = candidate.bandwidth;
    link.latency = candidate.latency;
    this.#notify('link_updated', linkId);
    return link;
  }

  removeLink(linkId) {
    if (!this.links.has(linkId)) throw new ValueError('unknown link ID');
    const link = this.links.get(linkId);
    this.#notify('link_removing', linkId);
    this.adjacency.get(link.source).delete(link.destination);
    this.adjacency.get(link.destination).delete(link.source);
    this.links.delete(linkId);
    this.#notify('link_deleted', linkId);
  }

  removeNode(nodeId) {
    if (!this.nodes.has(nodeId)) throw new ValueError('unknown node ID');
    const incident = [...this.adjacency.get(nodeId).values()].sort(cmp);
    this.#notify('node_removing', nodeId);
    incident.forEach((linkId) => this.removeLink(linkId));
    this.adjacency.delete(nodeId);
    this.nodes.delete(nodeId);
    this.#notify('node_deleted', nodeId);
  }

  #notify(kind, component) {
    if (this.onChange) this.onChange(kind, component);
  }

  #setStatus(components, component, status, kind) {
    if (!components.has(component)) throw new ValueError(`unknown ${kind} ID`);
    const item = components.get(component);
    if (item.status === status) return;
    item.status = status;
    this.#notify(`${kind}_${status === 'failed' ? 'failed' : 'restored'}`, component);
  }

  failNode(id) { this.#setStatus(this.nodes, id, 'failed', 'node'); }
  recoverNode(id) { this.#setStatus(this.nodes, id, 'operational', 'node'); }
  failLink(id) { this.#setStatus(this.links, id, 'failed', 'link'); }
  recoverLink(id) { this.#setStatus(this.links, id, 'operational', 'link'); }

  operational(link) {
    return link.status === 'operational'
      && this.nodes.get(link.source).status === 'operational'
      && this.nodes.get(link.destination).status === 'operational';
  }

  // Dijkstra using link latency plus optional nonnegative congestion costs.
  route(source, destination, penalties = {}) {
    if (!this.nodes.has(source) || !this.nodes.has(destination)) throw new ValueError('unknown routing endpoint');
    if (Object.values(penalties).some((v) => !Number.isFinite(v) || v < 0)) {
      throw new ValueError('routing penalties must be finite and nonnegative');
    }
    if ([source, destination].some((n) => this.nodes.get(n).status === 'failed')) return [];
    const distances = new Map([[source, 0]]);
    const previous = new Map();
    const heap = new MinHeap();
    heap.push([0, source]);
    while (heap.size) {
      const [distance, node] = heap.pop();
      if (distance !== distances.get(node)) continue;
      if (node === destination) {
        const path = [node];
        let current = node;
        while (current !== source) { current = previous.get(current); path.push(current); }
        return path.reverse();
      }
      const neighbors = [...this.adjacency.get(node).entries()].sort((a, b) => cmp(a[0], b[0]));
      for (const [neighbor, linkId] of neighbors) {
        const link = this.links.get(linkId);
        if (!this.operational(link)) continue;
        const candidate = distance + link.latency + (penalties[linkId] ?? 0);
        if (candidate < (distances.get(neighbor) ?? Infinity)) {
          distances.set(neighbor, candidate);
          previous.set(neighbor, node);
          heap.push([candidate, neighbor]);
        }
      }
    }
    return [];
  }
}

export class Packet {
  constructor(id, source, destination, size, priority, creationTime, deadline, node, extra = {}) {
    this.id = id; this.source = source; this.destination = destination; this.size = size;
    this.priority = priority; this.creation_time = creationTime; this.deadline = deadline;
    this.node = node; this.traffic = extra.traffic ?? 'normal';
    this.delivery_time = null; this.route = extra.route ?? []; this.status = 'queued';
    this.path = extra.path ?? []; this.link = null; this.next_node = null; this.arrives_at = null;
    this.remaining_bytes = 0; this.drop_reason = null; this.queue_order = 0; this.queued_link = null;
  }
  get packet_class() { return this.priority; }
  get latency_seconds() {
    return this.delivery_time === null ? null : this.delivery_time - this.creation_time;
  }
  toJSON() {
    return {
      ...this, route: [...this.route], path: [...this.path],
      packet_class: this.packet_class, latency_seconds: this.latency_seconds,
    };
  }
}

const EMERGENCY = new Set(['hospital', 'police', 'fire', 'rescue', 'ambulance']);

export class Simulator {
  constructor(network, { queueCapacity = 100, packetBytes = 1024, lifetime = 60, congestionWeight = 1.0 } = {}) {
    positiveInteger(queueCapacity, 'queue_capacity');
    positiveInteger(packetBytes, 'packet_bytes');
    positiveInteger(lifetime, 'lifetime');
    if (!Number.isFinite(congestionWeight) || congestionWeight < 0) {
      throw new ValueError('congestion_weight must be finite and nonnegative');
    }
    this.network = new Network([...network.nodes.values()], [...network.links.values()]);
    this.queueCapacity = queueCapacity;
    this.packetBytes = packetBytes;
    this.lifetime = lifetime;
    this.congestionWeight = congestionWeight;
    this.time = 0;
    this.packets = new Map();
    this.queues = new Map([...network.nodes.keys()].map((n) => [n, []]));
    this.linkQueues = new Map([...network.links.keys()].map((l) => [l, []]));
    this.events = [];
    this.queueSequence = 0;
    this.network.onChange = (kind, component) => this.#networkChanged(kind, component);
  }

  #event(kind, details = {}) {
    this.events.push({ time: this.time, kind, ...details });
  }

  inject(source, destination, traffic = 'normal', { size = null, priority = null } = {}) {
    if (!this.network.nodes.has(source) || !this.network.nodes.has(destination)) throw new ValueError('unknown packet endpoint');
    if (typeof traffic !== 'string') throw new ValueError('unknown traffic class');
    traffic = traffic.toLowerCase();
    if (!EMERGENCY.has(traffic) && traffic !== 'normal' && traffic !== 'emergency') throw new ValueError('unknown traffic class');
    size = size ?? this.packetBytes;
    positiveInteger(size, 'packet size');
    const emergency = traffic === 'emergency' || EMERGENCY.has(traffic);
    if (priority !== null && typeof priority !== 'string') throw new ValueError('priority must be normal or emergency');
    priority = priority !== null ? priority.toLowerCase() : (emergency ? 'emergency' : 'normal');
    if (priority !== 'normal' && priority !== 'emergency') throw new ValueError('priority must be normal or emergency');
    if (emergency && priority !== 'emergency') throw new ValueError('emergency traffic must have emergency priority');
    const packet = new Packet(this.packets.size + 1, source, destination, size, priority,
      this.time, this.time + this.lifetime, source,
      { traffic, path: [source], route: this.network.route(source, destination) });
    this.packets.set(packet.id, packet);
    this.#event('injected', { packet: packet.id });
    if (this.network.nodes.get(source).status === 'failed') this.#drop(packet, 'source_failed');
    else if (!packet.route.length) this.#drop(packet, 'unreachable');
    else if (source === destination) this.#deliver(packet);
    else this.#enqueue(packet, source);
    return packet;
  }

  generatePacket(source, destination, { size = null, priority = 'normal' } = {}) {
    return this.inject(source, destination, 'normal', { size, priority });
  }

  #enqueue(packet, node) {
    packet.node = node;
    packet.status = 'queued';
    packet.queue_order = ++this.queueSequence;
    this.queues.get(node).push(packet.id);
    this.#assignLinkQueue(packet);
  }

  #removeFromQueues(packet) {
    const remove = (list, id) => { const i = list.indexOf(id); if (i >= 0) list.splice(i, 1); };
    if (packet.node !== null && this.queues.has(packet.node)) remove(this.queues.get(packet.node), packet.id);
    if (packet.queued_link !== null && this.linkQueues.has(packet.queued_link)) {
      remove(this.linkQueues.get(packet.queued_link), packet.id);
    }
    packet.queued_link = null;
  }

  #assignLinkQueue(packet) {
    if (packet.status !== 'queued' || packet.node === null || packet.route.length < 2) return;
    const linkId = this.network.adjacency.get(packet.node).get(packet.route[1]);
    if (packet.queued_link === linkId) return;
    if (packet.queued_link !== null) {
      const list = this.linkQueues.get(packet.queued_link);
      list.splice(list.indexOf(packet.id), 1);
      packet.queued_link = null;
    }
    if (this.linkQueues.get(linkId).length >= this.queueCapacity) {
      this.#drop(packet, 'queue_overflow');
      return;
    }
    packet.queued_link = linkId;
    this.linkQueues.get(linkId).push(packet.id);
    this.#event('queued', { packet: packet.id, node: packet.node, link: linkId, priority: packet.priority, route: [...packet.route] });
  }

  #drop(packet, reason) {
    this.#removeFromQueues(packet);
    packet.status = 'dropped';
    packet.drop_reason = reason;
    packet.link = packet.next_node = packet.arrives_at = null;
    packet.remaining_bytes = 0;
    this.#event('dropped', { packet: packet.id, reason });
  }

  #deliver(packet) {
    packet.status = 'delivered';
    packet.delivery_time = this.time;
    this.#event('delivered', { packet: packet.id });
  }

  #updateRoute(packet, route, reason, { component = null, previousRoute = null } = {}) {
    const oldRoute = [...(previousRoute ?? packet.route)];
    packet.route = [...route];
    if (oldRoute.length === packet.route.length && oldRoute.every((n, i) => n === packet.route[i])) return;
    const details = { packet: packet.id, previous_route: oldRoute, route: [...packet.route], reason };
    if (component !== null) details.component = component;
    this.#event('route_recalculated', details);
  }

  #incident(packet, component) {
    if (packet.link === null) return false;
    const link = this.network.links.get(packet.link);
    return component === link.source || component === link.destination;
  }

  #networkChanged(kind, component) {
    if (kind !== 'link_removing' && kind !== 'node_removing') this.#event(kind, { component });
    if (kind === 'node_added') {
      this.queues.set(component, []);
    } else if (kind === 'link_added') {
      this.linkQueues.set(component, []);
    } else if (kind === 'link_removing') {
      for (const packet of [...this.packets.values()]) {
        if (packet.status === 'in_flight' && packet.link === component) this.#drop(packet, 'link_deleted');
      }
      return;
    } else if (kind === 'node_removing') {
      for (const packet of [...this.packets.values()]) {
        if (packet.status !== 'queued' && packet.status !== 'in_flight') continue;
        const incident = this.#incident(packet, component);
        if (component === packet.source || component === packet.destination) this.#drop(packet, 'endpoint_deleted');
        else if (packet.node === component || incident) this.#drop(packet, 'node_deleted');
      }
      return;
    } else if (kind === 'link_deleted') {
      for (const id of this.linkQueues.get(component) ?? []) {
        const packet = this.packets.get(id);
        if (packet.status === 'queued') packet.queued_link = null;
      }
      this.linkQueues.delete(component);
    } else if (kind === 'node_deleted') {
      this.queues.delete(component);
      for (const packet of [...this.packets.values()]) {
        if ((packet.status === 'queued' || packet.status === 'in_flight')
          && (component === packet.source || component === packet.destination)) {
          this.#drop(packet, 'endpoint_deleted');
        }
      }
    }

    const routeChanges = new Set(['node_failed', 'link_failed', 'node_restored', 'link_restored',
      'link_updated', 'link_deleted', 'node_deleted']);
    if (!routeChanges.has(kind)) return;
    for (const packet of this.packets.values()) {
      if (packet.status !== 'queued' && packet.status !== 'in_flight') continue;
      let affected = false;
      if (kind === 'node_failed') affected = packet.node === component || this.#incident(packet, component);
      else if (kind === 'link_failed') affected = packet.link === component;
      if (affected) {
        this.#drop(packet, kind);
      } else if (packet.status === 'queued') {
        this.#updateRoute(packet, this.network.route(packet.node, packet.destination), kind, { component });
        if (!packet.route.length) this.#drop(packet, 'unreachable');
        else this.#assignLinkQueue(packet);
      }
    }
  }

  // Fail real components using deterministic, educational disaster presets.
  triggerDisaster(disaster, intensity = 'medium', { seed = 0 } = {}) {
    const kinds = ['earthquake', 'flood', 'cyclone', 'cyberattack'];
    if (typeof disaster !== 'string' || !kinds.includes(disaster.toLowerCase())) throw new ValueError('unknown disaster type');
    if (typeof intensity !== 'string' || !['low', 'medium', 'high'].includes(intensity.toLowerCase())) {
      throw new ValueError('unknown disaster intensity');
    }
    if (!Number.isInteger(seed)) throw new ValueError('disaster seed must be an integer');
    disaster = disaster.toLowerCase();
    intensity = intensity.toLowerCase();
    const fraction = { low: 0.2, medium: 0.4, high: 0.65 }[intensity];
    const rng = seededRandom(seed);
    const nodes = [...this.network.nodes.values()].filter((n) => n.status === 'operational').map((n) => n.id).sort(cmp);
    const links = [...this.network.links.values()].filter((l) => l.status === 'operational').map((l) => l.id).sort(cmp);
    const choose = (values, count) => {
      count = Math.min(values.length, Math.max(0, count));
      return count ? rng.sample(values, count).sort(cmp) : [];
    };

    let failedNodes = [];
    let failedLinks = [];
    if (disaster === 'earthquake') {
      failedNodes = choose(nodes, Math.ceil((nodes.length * fraction) / 2));
      failedLinks = choose(links, Math.ceil((links.length * fraction) / 2));
    } else if (disaster === 'cyclone') {
      failedLinks = choose(links, Math.ceil(links.length * fraction));
      failedNodes = choose(nodes, pyRound(nodes.length * fraction * 0.2));
    } else if (disaster === 'cyberattack') {
      const infrastructure = nodes.filter((id) => ['router', 'switch'].includes(this.network.nodes.get(id).type));
      failedNodes = choose(infrastructure, Math.ceil(infrastructure.length * fraction));
      failedLinks = choose(links, pyRound(links.length * fraction * 0.15));
    } else {
      const components = [];
      for (const id of nodes) {
        const node = this.network.nodes.get(id);
        if (node.x !== null && node.y !== null) components.push([node.x, node.y, 'node', id]);
      }
      for (const id of links) {
        const link = this.network.links.get(id);
        const a = this.network.nodes.get(link.source);
        const b = this.network.nodes.get(link.destination);
        if ([a.x, a.y, b.x, b.y].every((v) => v !== null)) {
          components.push([(a.x + b.x) / 2, (a.y + b.y) / 2, 'link', id]);
        }
      }
      const count = Math.ceil((nodes.length + links.length) * fraction * 0.6);
      if (components.length) {
        const anchor = rng.choice(components);
        const dist = (item) => (item[0] - anchor[0]) ** 2 + (item[1] - anchor[1]) ** 2;
        const nearby = [...components]
          .sort((a, b) => dist(a) - dist(b) || cmp(a[2], b[2]) || cmp(a[3], b[3]))
          .slice(0, count);
        failedNodes = nearby.filter((i) => i[2] === 'node').map((i) => i[3]).sort(cmp);
        failedLinks = nearby.filter((i) => i[2] === 'link').map((i) => i[3]).sort(cmp);
      } else {
        const combined = [...nodes.map((i) => ['node', i]), ...links.map((i) => ['link', i])];
        const selected = count ? rng.sample(combined, Math.min(combined.length, count)) : [];
        failedNodes = selected.filter((s) => s[0] === 'node').map((s) => s[1]).sort(cmp);
        failedLinks = selected.filter((s) => s[0] === 'link').map((s) => s[1]).sort(cmp);
      }
    }

    this.#event('disaster_triggered', { disaster, intensity, seed });
    failedNodes.forEach((id) => this.network.failNode(id));
    failedLinks.forEach((id) => this.network.failLink(id));
    this.#event('recalculating_routes', { disaster });
    return { disaster, intensity, failed_nodes: failedNodes, failed_links: failedLinks };
  }

  setNodeActive(node, active) {
    if (typeof active !== 'boolean') throw new ValueError('active must be boolean');
    if (active) this.network.recoverNode(node); else this.network.failNode(node);
  }

  setLinkActive(linkId, active) {
    if (typeof active !== 'boolean') throw new ValueError('active must be boolean');
    if (active) this.network.recoverLink(linkId); else this.network.failLink(linkId);
  }

  #penalties() {
    const demand = new Map([...this.network.links.keys()].map((k) => [k, 0]));
    for (const [linkId, queue] of this.linkQueues) {
      demand.set(linkId, demand.get(linkId) + queue.reduce((sum, id) => sum + this.packets.get(id).size, 0));
    }
    for (const packet of this.packets.values()) {
      if (packet.status === 'in_flight') demand.set(packet.link, demand.get(packet.link) + packet.remaining_bytes);
    }
    const penalties = {};
    for (const [key, count] of demand) {
      penalties[key] = (this.congestionWeight * count) / this.network.links.get(key).bandwidth;
    }
    return penalties;
  }

  #transmitBytes(packet, link) {
    const amount = Math.min(packet.remaining_bytes, link.bandwidth - link.current_load);
    packet.remaining_bytes -= amount;
    link.current_load += amount;
    link.transmitted_bytes += amount;
    this.#event('bytes_transmitted', { packet: packet.id, link: link.id, size: amount });
    if (packet.remaining_bytes === 0) {
      // Serialization occupies this tick; propagation starts at its end.
      packet.arrives_at = this.time + 1 + link.latency;
    }
  }

  step(ticks = 1) {
    positiveInteger(ticks, 'ticks');
    for (let tick = 0; tick < ticks; tick++) {
      for (const link of this.network.links.values()) {
        link.current_load = 0;
        link.last_available_bytes = this.network.operational(link) ? link.bandwidth : 0;
        link.available_bytes += link.last_available_bytes;
      }
      // Complete serialization already started; transmission is not preempted.
      for (const packet of this.packets.values()) {
        if (packet.status === 'in_flight' && packet.remaining_bytes) {
          this.#transmitBytes(packet, this.network.links.get(packet.link));
        }
      }
      const penalties = this.#penalties();
      const waiting = [...this.queues.values()].flat().map((id) => this.packets.get(id));
      waiting.sort((a, b) => a.queue_order - b.queue_order);
      for (const packet of waiting) {
        const route = this.network.route(packet.node, packet.destination, penalties);
        this.#updateRoute(packet, route, 'forwarding');
        if (!packet.route.length) { this.#drop(packet, 'unreachable'); continue; }
        this.#assignLinkQueue(packet);
      }
      for (const [linkId, queue] of this.linkQueues) {
        const link = this.network.links.get(linkId);
        const ordered = [...queue].sort((a, b) => {
          const pa = this.packets.get(a), pb = this.packets.get(b);
          return (pa.priority !== 'emergency') - (pb.priority !== 'emergency') || pa.queue_order - pb.queue_order;
        });
        for (const packetId of ordered) {
          if (link.current_load >= link.bandwidth) break;
          const packet = this.packets.get(packetId);
          this.#removeFromQueues(packet);
          packet.status = 'in_flight';
          packet.node = null;
          packet.link = link.id;
          packet.next_node = packet.route[1];
          packet.remaining_bytes = packet.size;
          this.#event('transmitted', { packet: packet.id, link: link.id, priority: packet.priority, route: [...packet.route] });
          this.#transmitBytes(packet, link);
        }
      }
      this.time += 1;
      for (const packet of this.packets.values()) {
        if ((packet.status === 'queued' || packet.status === 'in_flight') && packet.deadline <= this.time) {
          this.#drop(packet, 'lifetime_expired');
        } else if (packet.status === 'in_flight' && packet.arrives_at === this.time) {
          const node = packet.next_node;
          packet.path.push(node);
          packet.node = node;
          packet.link = packet.next_node = packet.arrives_at = null;
          this.#event('arrived', { packet: packet.id, node });
          if (node === packet.destination) {
            this.#deliver(packet);
          } else {
            let expected = packet.route;
            if (packet.route.includes(node)) expected = packet.route.slice(packet.route.indexOf(node));
            const route = this.network.route(node, packet.destination);
            this.#updateRoute(packet, route, 'arrival', { previousRoute: expected });
            if (!packet.route.length) this.#drop(packet, 'unreachable');
            else this.#enqueue(packet, node);
          }
        }
      }
    }
  }

  metrics() {
    const all = [...this.packets.values()];
    const delivered = all.filter((p) => p.status === 'delivered');
    const dropped = all.filter((p) => p.status === 'dropped').length;
    const count = all.length;
    const averageLatency = (packets) => (packets.length
      ? packets.reduce((s, p) => s + (p.delivery_time - p.creation_time), 0) / packets.length : null);
    const average = averageLatency(delivered);
    const emergencyLatency = averageLatency(delivered.filter((p) => p.priority === 'emergency'));
    const normalLatency = averageLatency(delivered.filter((p) => p.priority === 'normal'));
    const classMetrics = (cls) => {
      const packets = all.filter((p) => p.priority === cls);
      const done = packets.filter((p) => p.status === 'delivered');
      return {
        generated: packets.length,
        delivered: done.length,
        dropped: packets.filter((p) => p.status === 'dropped').length,
        pending: packets.filter((p) => p.status === 'queued' || p.status === 'in_flight').length,
        average_latency_seconds: averageLatency(done),
      };
    };
    const links = {};
    for (const [key, link] of this.network.links) {
      const queue = this.linkQueues.get(key);
      links[key] = {
        transmitted_bytes: link.transmitted_bytes,
        available_bytes: link.available_bytes,
        current_load: link.current_load,
        utilization: link.utilization,
        queue_depth: queue.length,
        queue_capacity: this.queueCapacity,
        queued_normal: queue.filter((id) => this.packets.get(id).priority === 'normal').length,
        queued_emergency: queue.filter((id) => this.packets.get(id).priority === 'emergency').length,
        last_tick_utilization: link.last_available_bytes ? link.current_load / link.last_available_bytes : null,
      };
    }
    return {
      elapsed_seconds: this.time,
      injected: count, delivered: delivered.length, dropped,
      packets_generated: count,
      packets_delivered: delivered.length,
      packets_dropped: dropped,
      pending: count - delivered.length - dropped,
      average_latency_seconds: average,
      mean_latency_seconds: average,
      packet_latency_seconds: average,
      emergency_packet_latency_seconds: emergencyLatency,
      normal_packet_latency_seconds: normalLatency,
      emergency_average_latency_seconds: emergencyLatency,
      normal_average_latency_seconds: normalLatency,
      throughput_bps: this.time ? (delivered.reduce((s, p) => s + p.size, 0) * 8) / this.time : 0,
      packet_loss_ratio: count ? dropped / count : 0,
      packet_loss_percentage: count ? (100 * dropped) / count : 0,
      traffic_classes: { normal: classMetrics('normal'), emergency: classMetrics('emergency') },
      links,
    };
  }

  snapshot() {
    const link = (l) => ({ ...l, utilization: l.utilization });
    return {
      time: this.time,
      nodes: Object.fromEntries([...this.network.nodes].map(([k, n]) => [k, { ...n }])),
      links: [...this.network.links.values()].map(link),
      queues: Object.fromEntries([...this.queues].map(([k, q]) => [k, [...q]])),
      link_queues: Object.fromEntries([...this.linkQueues].map(([k, q]) => [k, [...q]])),
      packets: [...this.packets.values()].map((p) => p.toJSON()),
      metrics: this.metrics(),
      events: structuredClone(this.events),
    };
  }
}
