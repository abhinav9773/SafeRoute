import { useState } from 'react';
import { BookOpen, ChevronDown, ChevronUp, Eye, Play, RotateCcw, SkipForward } from 'lucide-react';
import { api } from '../api';
/** Topology used by the tour. Links are slow (512 B/s) so queues become visible. */
const DEMO_TOPOLOGY = {
    nodes: [
        { id: 'hospital', name: 'Hospital', type: 'hospital', x: 70, y: 170 },
        { id: 'router', name: 'Primary Router', type: 'router', x: 300, y: 40 },
        { id: 'backup', name: 'Backup Router', type: 'router', x: 300, y: 300 },
        { id: 'rescue', name: 'Rescue Center', type: 'rescue', x: 530, y: 170 },
    ],
    links: [
        { id: 'hospital-router', source: 'hospital', destination: 'router', bandwidth: 512, latency: 1 },
        { id: 'router-rescue', source: 'router', destination: 'rescue', bandwidth: 512, latency: 1 },
        { id: 'hospital-backup', source: 'hospital', destination: 'backup', bandwidth: 512, latency: 2 },
        { id: 'backup-rescue', source: 'backup', destination: 'rescue', bandwidth: 512, latency: 1 },
    ],
};
const normal = (count) => () => api.normalTraffic({ source: 'hospital', destination: 'rescue', count, size: 1024 });
const STEPS = [
    {
        title: 'Start a fresh network',
        concept: 'Network as a graph',
        what: 'Loads a 4-node network: a Hospital and a Rescue Center joined by a fast primary path (via the Primary Router) and a slower backup path (via the Backup Router). Every link carries 512 bytes per second.',
        watch: ['Four nodes and four links on the graph', 'The clock in the header (SIM T+…s) starts ticking'],
        run: () => api.startWith({
            topology: DEMO_TOPOLOGY, tick_interval_seconds: 0.7, packet_bytes: 1024, congestion_weight: 0.25,
        }),
    },
    {
        title: 'Send one normal packet',
        concept: 'Dijkstra shortest path',
        what: 'A 1024-byte packet goes from Hospital to Rescue Center. Dijkstra picks the lowest-cost path. The primary path has lower latency, so it wins.',
        watch: ['The packet travels Hospital → Primary Router → Rescue', 'Each hop takes ceil(size / bandwidth) + latency seconds', 'Average latency appears in the metrics once it is delivered'],
        run: normal(1),
    },
    {
        title: 'Create congestion',
        concept: 'Congestion-aware routing and queues',
        what: 'Sends 8 normal packets at once. They queue on the first link. Dijkstra adds a penalty based on queued bytes, so once the primary path is busy, later packets switch to the backup path.',
        watch: ['Queue depth rising on the Hospital links', 'Some packets rerouting via the Backup Router (see the event log)', 'Link utilization bars filling up'],
        run: normal(8),
    },
    {
        title: 'Emergency traffic jumps the queue',
        concept: 'Priority scheduling (QoS)',
        what: 'Sends one ambulance packet while normal packets are still waiting. Each link serves emergency packets first, then normal ones in arrival order. A normal packet already being sent is not interrupted.',
        watch: ['The emergency packet is transmitted ahead of waiting normal packets', 'Compare emergency latency with normal latency in the metrics', 'Both classes are counted separately'],
        run: () => api.emergencyTraffic({ source: 'hospital', destination: 'rescue', service: 'ambulance', count: 1, size: 1024 }),
    },
    {
        title: 'Fail a link',
        concept: 'Fault tolerance and rerouting',
        what: 'Fails the Hospital–Primary Router link. Packets being sent on it are dropped. Packets still waiting are rerouted over the backup path, and new traffic is sent there too.',
        watch: ['The failed link turns red and stays visible', 'route_recalculated events appear in the log', 'Latency rises because the backup path is slower'],
        run: async () => { await api.failLink('hospital-router'); await normal(3)(); },
    },
    {
        title: 'Cut the network in two',
        concept: 'Unreachable destinations and packet loss',
        what: 'Also fails the Hospital–Backup link. Now Hospital has no working path to Rescue. Packets sent are dropped immediately with the reason "unreachable".',
        watch: ['Packet loss % climbs in the metrics', 'Dropped packets show the reason unreachable', 'Packets that were already delivered are unaffected'],
        run: async () => { await api.failLink('hospital-backup'); await normal(3)(); },
    },
    {
        title: 'Recover the links',
        concept: 'Restoration',
        what: 'Brings both links back and sends an emergency packet. Recovery lets new traffic flow again, but packets already dropped are never revived.',
        watch: ['Links return to normal colour', 'The new packet is delivered', 'Loss % stays as it was because dropped packets stay dropped'],
        run: async () => {
            await api.recoverLink('hospital-router');
            await api.recoverLink('hospital-backup');
            await api.emergencyTraffic({ source: 'hospital', destination: 'rescue', service: 'rescue', count: 1, size: 1024 });
        },
    },
    {
        title: 'Trigger a disaster',
        concept: 'Disaster presets',
        what: 'Triggers a medium-intensity cyclone. Cyclones mostly damage links, and the backend fails them with the same methods as a manual failure. Here both links of the primary path go down, so traffic must use the backup path. Then it sends traffic so you can see the effect.',
        watch: ['Two links turn red at once', 'New packets travel Hospital → Backup Router → Rescue', 'Try High intensity yourself on this small network and most of it will fail'],
        run: async () => { await api.triggerDisaster({ disaster: 'cyclone', intensity: 'medium', seed: 5 }); await normal(2)(); },
    },
    {
        title: 'Reset and explore',
        concept: 'Your turn',
        what: 'Resets the network to time zero with everything healthy. Now try it yourself: drag nodes, add routers and links, fail components, generate traffic, and trigger different disasters.',
        watch: ['Click Edit network on the map to add nodes and links', 'Select a link to change its bandwidth and latency', 'Try each disaster at each intensity'],
        run: () => api.reset(),
    },
];
export function GuidedDemo({ busy, onRun }) {
    const [open, setOpen] = useState(true);
    const [index, setIndex] = useState(0);
    const step = STEPS[index];
    const last = index === STEPS.length - 1;
    const run = () => {
        onRun(step.run);
        if (!last)
            setIndex(index + 1);
    };
    return (<section className="demo-panel panel">
      <div className="demo-header">
        <div className="demo-title">
          <BookOpen size={17}/>
          <div>
            <span className="eyebrow">Guided tour</span>
            <h2>Learn by doing</h2>
          </div>
        </div>
        <div className="demo-progress" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
          {STEPS.map((item, i) => (<button key={item.title} className={`demo-dot ${i === index ? 'is-current' : i < index ? 'is-done' : ''}`} title={item.title} onClick={() => setIndex(i)} aria-label={`Go to step ${i + 1}: ${item.title}`}/>))}
        </div>
        <button className="demo-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <><ChevronUp size={15}/> Hide</> : <><ChevronDown size={15}/> Show</>}
        </button>
      </div>

      {open && (<div className="demo-body">
          <div className="demo-text">
            <div className="demo-step-label">Step {index + 1} of {STEPS.length} · <b>{step.concept}</b></div>
            <h3>{step.title}</h3>
            <p>{step.what}</p>
          </div>
          <div className="demo-watch">
            <h4><Eye size={14}/> What to watch</h4>
            <ul>{step.watch.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
          <div className="demo-actions">
            <button className="button button--primary" disabled={busy} onClick={run}>
              <Play size={15}/> {index === 0 ? 'Start tour' : last ? 'Reset network' : 'Run this step'}
            </button>
            <button className="button" disabled={last} onClick={() => setIndex(index + 1)}>
              <SkipForward size={15}/> Skip
            </button>
            <button className="button" disabled={index === 0} onClick={() => setIndex(0)}>
              <RotateCcw size={15}/> Restart tour
            </button>
          </div>
        </div>)}
    </section>);
}
