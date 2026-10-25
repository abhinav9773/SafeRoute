# Project Explanation

**Adaptive Disaster-Resilient Communication Network Simulator**

## 1. What problem does it solve?

When an earthquake, flood, cyclone, or cyberattack hits, parts of a communication network fail. Hospitals, police, fire stations, and rescue teams still need to talk to each other. This project simulates such a network and shows how it can:

- detect failed nodes and links,
- find new routes around the damage,
- avoid congested links,
- let emergency traffic go ahead of ordinary traffic,
- measure how well it all worked, using real numbers from the simulation.

## 2. Computer Networks concepts demonstrated

| Concept | Where it appears in the project |
|---|---|
| Network as a graph | `Network` stores nodes, links, and an adjacency map |
| Shortest-path routing | Dijkstra with a min-heap in `Network.route` |
| Link-state style centralized routing | Routes are recomputed whenever topology or health changes |
| Congestion-aware routing | Link cost = latency + congestion penalty from queued bytes |
| Store-and-forward switching | Packets are fully received at a node, queued, then forwarded |
| Transmission vs propagation delay | `ceil(size / bandwidth)` plus `latency` per hop |
| Bandwidth and utilization | Bytes per second capacity, utilization = transmitted / available |
| Queueing and buffer overflow | Finite per-link queues; overflow drops the packet |
| Priority scheduling (QoS) | Strict emergency-first, FIFO within each class |
| Fault tolerance and failover | Failure drops affected packets, rerouting handles the rest |
| Packet loss and TTL | Drop reasons recorded; packets expire after a lifetime |
| Performance metrics | Latency, throughput, loss, utilization |

## 3. Architecture

```
┌────────────────────────┐   HTTP/JSON (poll every 800 ms)   ┌──────────────────────┐
│  React frontend        │ ────────────────────────────────▶ │  Express backend     │
│  - React Flow graph    │ ◀──────────────────────────────── │  - routes, schemas   │
│  - controls, metrics   │                                   │  - SimulationManager │
│  - event log           │                                   │    (async lock,      │
└────────────────────────┘                                   │     background tick) │
                                                             └──────────┬───────────┘
                                                                        │ calls
                                                             ┌──────────▼───────────┐
                                                             │  Simulation engine   │
                                                             │  simulator/engine.py │
                                                             │  (pure JavaScript)   │
                                                             └──────────────────────┘
```

Design principles:

1. **The engine is independent.** It has no web or UI dependencies and can be tested and used alone.
2. **The backend is a thin adapter.** It calls engine methods and returns snapshots. It does not invent data.
3. **The frontend is only a view.** It holds no topology or metrics of its own. It reads everything from the API and sends commands back.
4. **Deterministic behavior.** Tie-breaking and seeds make runs reproducible, which helps testing and demos.

## 4. The simulation engine (`server/src/engine.js`)

### 4.1 Data models

- **Node**: `id`, `name`, `status` (operational or failed), `type` (router, switch, hospital, police, fire, rescue, ambulance), and optional `x`, `y` coordinates for the editor. Emergency services are ordinary graph vertices with a descriptive type.
- **Link**: `id`, `source`, `destination`, `bandwidth` (bytes per second), `latency` (propagation delay in seconds), `status`. It also tracks transmitted bytes and available bytes to compute utilization. Links are undirected, with no self-loops and no parallel links.
- **Packet**: `id`, source, destination, `size` in bytes, `priority` (normal or emergency), creation time, deadline, planned `route`, actual `path`, `status` (queued, in_flight, delivered, dropped), and a `drop_reason` when dropped.
- **Network**: holds the graph, validates changes, applies fail and recover operations, and runs Dijkstra.
- **Simulator**: owns a private copy of the network plus packets, queues, events, and the clock.

### 4.2 Time and units

One **tick** is one simulated second. Packet sizes are in bytes and link bandwidth is in bytes per second. These are simulated measurements, not real network measurements.

### 4.3 Routing: Dijkstra with congestion

`Network.route` runs Dijkstra using a heap. The cost of crossing a link is:

```
cost = link.latency + congestion_weight × (queued_bytes_on_link / bandwidth)
```

- Failed links and links touching failed nodes are skipped.
- If the source or destination has failed, there is no route.
- With `congestion_weight = 0`, it chooses minimum propagation latency.
- It is a heuristic: it does not guarantee the minimum end-to-end delivery time.

Every queued packet recalculates its route before it is forwarded, so new failures and new congestion affect packets already in the network.

### 4.4 What happens in one tick (`Simulator.step`)

1. Reset each link's per-tick load and add this tick's capacity (zero if the link or an endpoint is down).
2. Continue sending packets whose serialization already began. Transmission is not preempted.
3. Compute congestion penalties from queued byte demand.
4. For every waiting packet, recompute the route, record changes, drop it if unreachable, and place it on the queue of its next link.
5. For each link, pick packets in this order: **emergency first, then FIFO by arrival**, until the tick's bandwidth is used. Large packets take several ticks.
6. Advance the clock. Drop expired packets. For packets arriving at a node, record the arrival, deliver if it is the destination, otherwise recompute the route and enqueue at that node.

### 4.5 Delay model

For an uncongested single hop:

```
delivery time = ceil(size / bandwidth) + latency
```

Example: a 2048-byte packet on a 1024 B/s link with 2 s latency takes 2 s serialization plus 2 s propagation, so 4 ticks.

### 4.6 Queues and priority

- Each link has one queue shared by both directions. The maximum is `queue_capacity` packets (default 100). Overflow drops the incoming packet with reason `queue_overflow`.
- Emergency packets overtake all normal packets still waiting on that link. A normal packet already being transmitted is not interrupted.
- Packets to or from hospital, ambulance, police, fire, and rescue are automatically emergency class. Downgrading them is rejected.
- Normal traffic can starve under sustained emergency load. This is a known trade-off of strict priority.

### 4.7 Failure and recovery

| Event | Effect |
|---|---|
| Link fails | Packets being sent on that link are dropped. Queued packets reroute. |
| Node fails | Packets queued at the node and all packets on its links are dropped. Others reroute. |
| No path exists | Packet is dropped with reason `unreachable`. |
| Component recovers | New traffic can use it. Dropped packets are not revived. |
| Node or link deleted | Affected packets are dropped with a reason. Others recalculate. |

A `route_recalculated` event records the old route, the new route, and the cause.

### 4.8 Disaster presets (`trigger_disaster`)

These are understandable failure patterns, not physical hazard models. Intensity decides the fraction of components that fail: **low 20%, medium 40%, high 65%**. A seed makes the choice reproducible. Every failure goes through the same `fail_node` and `fail_link` methods as a manual failure.

| Preset | What fails |
|---|---|
| Earthquake | A mix of random nodes and links |
| Flood | A geographic cluster around a random anchor, using node coordinates |
| Cyclone | Mostly links, a few nodes |
| Cyberattack | Mostly routers and switches, a few links |

### 4.9 Metrics

Every metric comes from actual packet events and transmitted bytes.

| Metric | Definition |
|---|---|
| Average latency | Mean of (delivery time − creation time) over delivered packets |
| Emergency / normal latency | The same mean, measured separately per class |
| Throughput (bits/s) | Delivered bytes × 8 ÷ elapsed seconds |
| Packet loss % | Dropped ÷ injected × 100 |
| Link utilization | Transmitted bytes ÷ available bytes (only counts time when the link is up) |
| Queue depth | Waiting packets per link, split by class |

Conservation check: `injected = delivered + dropped + pending`.

### 4.10 Events

Each event has a time and kind. Kinds include `injected`, `queued`, `transmitted`, `bytes_transmitted`, `arrived`, `delivered`, `dropped`, `route_recalculated`, `node_failed`, `link_failed`, `node_restored`, `link_restored`, `disaster_triggered`, and `recalculating_routes`. The frontend turns these into the readable event log.

## 5. The backend (`server/src/`)

- **`validate.js`** checks every request body (types, ranges, allowed values, unknown fields) and rejects bad input with a clear message.
- **`app.js`** has `createApp()` and `SimulationManager`.
  - The manager owns exactly one `Simulator`.
  - Node.js runs JavaScript on a single thread, so each API call runs to completion before the next starts and the background ticker never overlaps with a request.
  - While running, a timer advances the engine one tick per configured real-time interval.
  - Pause stops the clock. Reset rebuilds the latest edited topology at time zero.
  - `POST /simulation/start` with no body resumes. With a body, it starts a fresh run using the supplied topology and settings.
  - Engine errors become HTTP errors: "unknown ..." gives 404, other validation errors give 400, and bad request bodies give 422.
- **`index.js`** starts the server (port 8000 by default) and opens the browser. **`demo.js`** is a terminal demo of the engine.
- A default four-node topology is built in: Hospital and Rescue Center joined by a fast primary path through a Primary Router and a slower backup path through a Backup Router.
- CORS allows the Vite dev and preview ports by default, and can be overridden with `FRONTEND_ORIGINS`.

## 6. The frontend (`frontend/src/`)

| File | Role |
|---|---|
| `api.js` | Fetch wrapper for every endpoint |
| `App.jsx` | Polls `/topology`, `/metrics`, `/events` every 800 ms and holds app state |
| `components/NetworkGraph.jsx` | React Flow canvas: node palette, link creation, drag to move, packets and active routes, failed components shown distinctly |
| `components/ControlPanel.jsx` | Start, pause, reset, traffic injection, disaster triggers |
| `components/MetricsDashboard.jsx` | Metric cards and per-link utilization bars |
| `components/EventLog.jsx` | Newest-first, human-readable event stream |
| `components/GuidedDemo.jsx` | Nine-step narrated tour. Each step calls the same public API as the manual controls |

The browser never computes routes, moves packets, or calculates metrics. It only displays what the backend reports.

### Guided tour

The tour is a list of steps, each with a concept name, a plain-language explanation, "what to watch" hints, and an action that calls the API (start a run, inject traffic, fail a link, trigger a disaster). It uses its own four-node topology with 512 B/s links so queues are visible, and a congestion weight of 0.25 so the primary path wins when the network is quiet. The steps were checked against the engine: the first packet takes the primary path in 6 s, a burst of eight queues up on the first link, an emergency packet arrives in about 6 to 7 s while normal packets average about 10 s, and the failure, recovery and cyclone steps behave as described (the cyclone step uses seed 5, which fails both primary links and leaves the backup path).

### Serving

The backend serves the built dashboard from `frontend/dist` at `/`, and the API routes take precedence. That is why `npm start` is enough to use the whole application on one port.

## 7. Walkthrough of a demo

Default topology: `Hospital → Router → Rescue` (fast) and `Hospital → Backup → Rescue` (slower).

1. Start the simulation and send an ambulance packet from Hospital to Rescue. It takes the fast path through the Primary Router.
2. Fail the `hospital-router` link. Queued packets are rerouted through the Backup Router, and a `route_recalculated` event appears. Latency rises because the backup path is slower.
3. Send heavy normal traffic plus one emergency packet. The emergency packet is transmitted first on each shared link, so its latency stays low while normal latency grows.
4. Fail the backup link as well. Now no path exists, so new packets are dropped as `unreachable` and loss percentage climbs.
5. Recover a link. New traffic flows again, but earlier dropped packets stay dropped.
6. Trigger a **high-intensity flood** and watch which components go dark and how the metrics change.

## 8. Testing

Run `npm test` from the project root. There are 62 tests in four files (Node's built-in test runner, no extra dependencies):

| File | Focus |
|---|---|
| `engine.test.js` | Models, graph validation, shortest paths, failure exclusion, rerouting, serialization, queue overflow, exact metric arithmetic, determinism |
| `resilience.test.js` | Emergency-first scheduling under heavy normal load, disaster presets and real failure effects, recovery |
| `api.test.js` | Lifecycle, background ticking, traffic, health controls, topology editing, validation, CORS |
| `static.test.js` | Dashboard served at `/` with API routes intact, and API-only mode without a build |

The engine was ported from a Python version. Both were run on identical scenarios and produced identical snapshots, including every event.

## 9. Deliberate simplifications

- Whole-second tick resolution.
- Undirected links with shared bandwidth in both directions.
- Centralized, instantaneous route computation (no routing-protocol convergence delay).
- No sockets, TCP, retransmission, or fragmentation.
- Disaster presets are category and proximity based, not physical models.
- One in-memory simulation per server process, with no authentication or persistence.

## 10. Likely viva questions

**Why Dijkstra?** Link costs are non-negative (latency plus a non-negative congestion penalty), and Dijkstra with a heap gives shortest paths in O((V + E) log V).

**How is this congestion-aware?** Queued bytes on a link, divided by its bandwidth, become a time-like penalty added to its cost, so busy links look more expensive.

**How do emergency packets get priority?** Each link scheduler serves emergency packets before normal ones, FIFO within a class. It changes real bandwidth usage and so real latency.

**What is the cost of strict priority?** Normal traffic can starve under sustained emergency load.

**Why not preempt a normal packet already sending?** It models real transmission, where a frame on the wire cannot be stopped midway.

**What does a failure do to in-flight packets?** Packets on the failed link or node are dropped. Packets elsewhere continue and reroute at their next node.

**Are the metrics real?** They are measured from the simulation's own packet events and byte counters, in simulated time. They are not measurements of a real network.

**Why separate engine and API?** So the networking logic stays testable and independent of any framework, and the UI cannot fabricate results.

**What would you add next?** Directed links, a routing-protocol model with convergence delay, TCP-like retransmission, persistence, multi-user sessions, and physically grounded hazard models.
