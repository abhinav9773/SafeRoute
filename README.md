# SafeRoute: Adaptive Disaster-Resilient Communication Network Simulator

A Computer Networks course project. It simulates a communication network (routers, switches, hospitals, police, fire stations, rescue centres) that keeps working when a disaster knocks out parts of it. It reroutes traffic with Dijkstra's algorithm, gives emergency traffic priority, and shows everything live in a web dashboard with a built-in guided tour.

For a full explanation of how it works, read [PROJECT_EXPLANATION.md](PROJECT_EXPLANATION.md).

## Tech stack

| Layer | Technology |
|---|---|
| Simulation engine | JavaScript (Node.js, no dependencies) |
| Backend API | Express |
| Frontend | React 19 + Vite + React Flow (plain JavaScript) |
| Tests | Node.js built-in test runner |

## Project structure

```
.
├── server/
│   ├── src/
│   │   ├── engine.js     # Node, Link, Packet, Network, Simulator
│   │   ├── app.js        # Express routes + SimulationManager (background clock)
│   │   ├── validate.js   # Request validation
│   │   ├── index.js      # Starts the server and opens the browser
│   │   └── demo.js       # Terminal demo
│   └── test/             # 62 unit and API tests
├── frontend/
│   ├── src/              # App.jsx, api.js, components/ (incl. GuidedDemo.jsx)
│   └── dist/             # Pre-built dashboard, served by the backend
├── package.json          # Scripts and backend dependencies
├── PROJECT_SPEC.md       # Detailed simulation contract
└── PROJECT_EXPLANATION.md
```

## Prerequisites

Node.js 18 or newer (check with `node --version`). Nothing else is needed.

## Quick start

Run these from the project root, the folder that contains `package.json`:

```bash
npm install
npm start
```

The dashboard opens at http://127.0.0.1:8000. Then use the **Guided tour** panel on the left. Each step runs a real scenario against the engine and tells you what to watch.

The dashboard is already built in `frontend/dist`, so you do not need to build anything to use it.

To stop the server, press **Ctrl+C**.

## All commands

| Command | What it does |
|---|---|
| `npm start` | Runs the API and the dashboard on one port (8000) |
| `npm run dev` | Same, but restarts the server when you edit backend files |
| `npm test` | Runs the 62 tests. Expected result: `# pass 62` |
| `npm run demo` | Terminal-only demo that prints the full simulation as JSON |
| `npm run setup` | Installs everything and rebuilds the dashboard (needed only after editing frontend code) |
| `npm run build` | Rebuilds the dashboard into `frontend/dist` |

### Windows (PowerShell)

The same commands work. Example:

```powershell
cd C:\Users\abhin\Desktop\SafeRoute
npm install
npm start
```

### Changing the port or hiding the browser

```bash
PORT=9000 npm start              # Windows PowerShell: $env:PORT=9000; npm start
NO_BROWSER=1 npm start           # do not open a browser window
```

## Development mode with hot reload (frontend)

Use two terminals from the project root.

**Terminal 1: backend**

```bash
npm start
```

**Terminal 2: frontend**

```bash
cd frontend
npm install
npm run dev
```

Open http://127.0.0.1:5173. It talks to the backend on port 8000. To rebuild the version the backend serves, run `npm run setup` from the root.

### Configuration

| Setting | How | Default |
|---|---|---|
| Server port and host | `PORT`, `HOST` environment variables | `8000`, `127.0.0.1` |
| Backend URL used by the frontend | `VITE_API_BASE_URL` at build time | Same origin when served by the backend, `http://127.0.0.1:8000` on the Vite dev and preview ports |
| Allowed frontend origins (CORS) | `FRONTEND_ORIGINS`, comma-separated | Vite dev and preview ports |
| Folder of the built dashboard | `FRONTEND_DIST` | `frontend/dist` |

## Using the dashboard

### Guided tour

The panel on the left walks through nine steps. Press **Run this step** to execute each one, or click a bar at the top of the panel to jump around:

1. Start a fresh 4-node network
2. Send one normal packet (Dijkstra shortest path)
3. Create congestion (queues build, traffic spills to the backup path)
4. Send emergency traffic (it jumps the queue)
5. Fail a link (packets reroute)
6. Cut the network in two (packets dropped as unreachable)
7. Recover the links
8. Trigger a cyclone preset
9. Reset and explore on your own

### Manual controls

1. Press **Start** in the top bar. The clock begins ticking.
2. **Send traffic:** choose From and To, then send a normal or an emergency packet.
3. **Break something:** click a node or link on the map and press **Fail**, or pick a disaster (earthquake, flood, cyclone, cyberattack) and an intensity, then trigger it. Press **Recover** to bring components back.
4. **Edit network:** press **Edit network** above the map to add routers, switches and emergency services, and to delete components. Drag from one node's dot to another to create a link. Select a link to change its bandwidth and latency.
5. Watch the results cards, the "how busy each link is" bars, and the live activity list.
6. **Hide panel** in the top bar gives the map more room when presenting. **Pause** and **Reset** are in the top bar too.

## Using the engine directly as a JavaScript module

```js
import { Link, Network, Node, Simulator } from './server/src/engine.js';

const network = new Network();
network.addNode(new Node('hospital', 'City Hospital', 'operational', 'hospital'));
network.addNode(new Node('rescue', 'Rescue Center', 'operational', 'rescue'));
network.addLink(new Link('radio', 'hospital', 'rescue', 1024, 2));

const sim = new Simulator(network);
const packet = sim.generatePacket('hospital', 'rescue', { size: 2048, priority: 'emergency' });
sim.step(4);                     // 2 s serialization + 2 s propagation
console.log(packet.status);      // delivered
console.log(sim.metrics());

sim.network.failLink('radio');
const lost = sim.inject('hospital', 'rescue', 'ambulance');
console.log(lost.drop_reason);   // unreachable
```

## API quick reference

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/topology` | Nodes, links, queues, packets, routes, failures |
| GET | `/metrics` | Latency, throughput, loss, utilization |
| GET | `/events` | Chronological simulation events (`since`, `limit`) |
| POST | `/simulation/start` | Start, or resume if no body is given |
| POST | `/simulation/pause` | Pause the clock |
| POST | `/simulation/reset` | Rebuild the current topology at time 0 |
| POST | `/traffic/normal` | Inject normal traffic |
| POST | `/traffic/emergency` | Inject emergency traffic |
| POST | `/nodes`, `/links` | Add a node or link |
| PATCH | `/nodes/:id`, `/links/:id` | Update a node or link |
| DELETE | `/nodes/:id`, `/links/:id` | Remove a node or link |
| POST | `/nodes/:id/fail`, `/nodes/:id/recover` | Node health |
| POST | `/links/:id/fail`, `/links/:id/recover` | Link health |
| POST | `/disasters/trigger` | Apply a disaster preset |

Example calls (the server must be running):

```bash
curl -X POST http://127.0.0.1:8000/simulation/start
curl http://127.0.0.1:8000/metrics
curl -X POST http://127.0.0.1:8000/links/hospital-router/fail
```

Errors come back as JSON: `{ "detail": "..." }` with status 404 (unknown component), 400 (invalid operation) or 422 (invalid request body).

## Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot find module 'express'` | Run `npm install` in the project root. |
| `npm start` says the port is in use | Use another port: `PORT=9000 npm start`. |
| Page shows the API but no dashboard | `frontend/dist` is missing. Run `npm run setup`. |
| Dashboard says the backend is unavailable | Make sure `npm start` is running and http://127.0.0.1:8000/topology opens. |
| CORS error in the browser console | Set `FRONTEND_ORIGINS` to include the URL you opened the dashboard on. |
| Old design still showing | Hard refresh with Ctrl+F5. |
| `node` is not recognised | Install Node.js 18 or newer from nodejs.org, then reopen the terminal. |

## Limitations

This is an educational simulator, not a real network emulator. It uses whole-second ticks, undirected shared-bandwidth links, centralized route computation, and category-based disaster presets. It does not model sockets, TCP retransmission, routing-protocol convergence, or fragmentation. State lives in memory in a single process.
