import { useCallback, useEffect, useState } from 'react';
import { Activity, CirclePause, CirclePlay, CloudOff, PanelLeftClose, PanelLeftOpen, RadioTower, RefreshCw, RotateCcw, X } from 'lucide-react';
import { api } from './api';
import { ControlPanel } from './components/ControlPanel';
import { EventLog } from './components/EventLog';
import { GuidedDemo } from './components/GuidedDemo';
import { MetricsDashboard } from './components/MetricsDashboard';
import { NetworkGraph } from './components/NetworkGraph';
const POLL_INTERVAL_MS = 800;
const TYPE_NAMES = {
    router: 'Router',
    switch: 'Switch',
    hospital: 'Hospital',
    police: 'Police Station',
    fire: 'Fire Station',
    rescue: 'Rescue Center',
    ambulance: 'Ambulance Station',
};
function App() {
    const [topology, setTopology] = useState(null);
    const [metrics, setMetrics] = useState(null);
    const [events, setEvents] = useState([]);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [source, setSource] = useState('');
    const [destination, setDestination] = useState('');
    const [selection, setSelection] = useState(null);
    const [service, setService] = useState('ambulance');
    const [focus, setFocus] = useState(false);
    const [welcome, setWelcome] = useState(() => {
        try { return localStorage.getItem('saferoute-welcome') !== 'hidden'; } catch { return true; }
    });
    const hideWelcome = () => {
        setWelcome(false);
        try { localStorage.setItem('saferoute-welcome', 'hidden'); } catch { /* storage unavailable */ }
    };
    const refresh = useCallback(async (showError = false) => {
        try {
            const [nextTopology, nextMetrics, nextEvents] = await Promise.all([
                api.topology(), api.metrics(), api.events(),
            ]);
            setTopology(nextTopology);
            setMetrics(nextMetrics);
            setEvents(nextEvents.events);
            setConnected(true);
            setError(null);
        }
        catch (requestError) {
            setConnected(false);
            if (showError)
                setError(requestError instanceof Error ? requestError.message : 'Backend unavailable');
        }
    }, []);
    useEffect(() => {
        void refresh(true);
        const interval = window.setInterval(() => void refresh(false), POLL_INTERVAL_MS);
        return () => window.clearInterval(interval);
    }, [refresh]);
    useEffect(() => {
        if (!topology)
            return;
        const operationalNodes = topology.nodes.filter((node) => node.status === 'operational');
        if (!topology.nodes.some((node) => node.id === source)) {
            setSource(operationalNodes[0]?.id || topology.nodes[0]?.id || '');
        }
        if (!topology.nodes.some((node) => node.id === destination)) {
            setDestination(operationalNodes.at(-1)?.id || topology.nodes.at(-1)?.id || '');
        }
        if (selection) {
            const exists = selection.kind === 'node'
                ? topology.nodes.some((node) => node.id === selection.id)
                : topology.links.some((link) => link.id === selection.id);
            if (!exists)
                setSelection(null);
        }
    }, [destination, selection, source, topology]);
    const mutate = useCallback(async (operation) => {
        setBusy(true);
        setError(null);
        try {
            await operation();
            await refresh(true);
        }
        catch (actionError) {
            setError(actionError instanceof Error ? actionError.message : 'Action failed');
        }
        finally {
            setBusy(false);
        }
    }, [refresh]);
    const handleAction = useCallback((action) => {
        const operations = {
            start: api.start,
            pause: api.pause,
            reset: api.reset,
            normal: () => api.normalTraffic({ source, destination, count: 1 }),
            emergency: () => api.emergencyTraffic({ source, destination, count: 1, service }),
        };
        if (operations[action])
            void mutate(operations[action]);
    }, [destination, mutate, service, source]);
    const addNode = useCallback((type) => {
        if (!topology)
            return;
        let number = topology.nodes.filter((node) => node.type === type).length + 1;
        let id = `${type}-${number}`;
        while (topology.nodes.some((node) => node.id === id))
            id = `${type}-${++number}`;
        // First free grid slot, so new nodes never land on top of existing ones.
        const free = (x, y) => !topology.nodes.some((n) => (Math.abs((n.x ?? -999) - x) < 170 && Math.abs((n.y ?? -999) - y) < 85));
        let slot = { x: 40, y: 20 };
        search: for (let row = 0; row < 60; row++) {
            for (let col = 0; col < 5; col++) {
                if (free(40 + col * 190, 20 + row * 100)) {
                    slot = { x: 40 + col * 190, y: 20 + row * 100 };
                    break search;
                }
            }
        }
        void mutate(() => api.createNode({ id, name: `${TYPE_NAMES[type]} ${number}`, type, ...slot }));
        setSelection({ kind: 'node', id });
    }, [mutate, topology]);
    const connectNodes = useCallback((first, second) => {
        if (!topology || first === second)
            return;
        const endpoints = [first, second].sort();
        const parallel = topology.links.some((link) => ([link.source, link.destination].sort().join('|') === endpoints.join('|')));
        if (parallel) {
            setError('Those components already have a communication link.');
            return;
        }
        const base = `${endpoints[0]}-${endpoints[1]}`;
        let id = base;
        let suffix = 2;
        while (topology.links.some((link) => link.id === id))
            id = `${base}-${suffix++}`;
        void mutate(() => api.createLink({ id, source: first, destination: second, bandwidth: 1024, latency: 1 }));
        setSelection({ kind: 'link', id });
    }, [mutate, topology]);
    if (!topology || !metrics) {
        return (<main className="boot-screen">
        <div className="boot-mark"><RadioTower size={28}/></div>
        <h1>SafeRoute</h1>
        {connected ? <p>Loading simulation state…</p> : (<>
            <p>Waiting for the FastAPI backend (start it with: python run.py)</p>
            {error && <div className="boot-error"><CloudOff size={15}/> {error}</div>}
            <button className="button button--primary" onClick={() => void refresh(true)}><RefreshCw size={15}/> Retry connection</button>
          </>)}
      </main>);
    }
    const running = topology.simulation_status === 'running';
    return (<div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark"><RadioTower size={18}/></div>
          <div><h1>SafeRoute</h1><span>Disaster-resilient network simulator</span></div>
        </div>
        <div className="header-group" role="group" aria-label="Simulation controls">
          <button className="button button--primary" disabled={busy || running} onClick={() => handleAction('start')}><CirclePlay size={16}/> Start</button>
          <button className="button" disabled={busy || !running} onClick={() => handleAction('pause')}><CirclePause size={16}/> Pause</button>
          <button className="button" disabled={busy} onClick={() => handleAction('reset')}><RotateCcw size={16}/> Reset</button>
        </div>
        <button className="button" onClick={() => setFocus(!focus)} title="Hide the side panel for a bigger map when presenting">
          {focus ? <><PanelLeftOpen size={16}/> Show panel</> : <><PanelLeftClose size={16}/> Hide panel</>}
        </button>
        <div className="header-status" role="status">
          <div className={`connection-pill ${connected ? 'is-online' : 'is-offline'}`}><i/> {connected ? 'Connected' : 'Offline'}</div>
          <div className={`run-pill run-pill--${topology.simulation_status}`}><Activity size={14}/> {topology.simulation_status}</div>
          <div className="header-time">T+{topology.time}s</div>
        </div>
      </header>

      {error && (<div className="error-banner" role="alert"><CloudOff size={16}/> {error}<button onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>)}

      <div className={`workspace ${focus ? 'is-focus' : ''}`}>
        <aside className="sidebar">
          <GuidedDemo busy={busy} onRun={(operation) => void mutate(operation)}/>
          <ControlPanel nodes={topology.nodes} busy={busy} source={source} destination={destination} service={service} onSourceChange={setSource} onDestinationChange={setDestination} onServiceChange={setService} onAction={handleAction} onDisaster={(disaster, intensity) => void mutate(() => api.triggerDisaster({ disaster, intensity }))}/>
        </aside>
        <main className="main-col">
          {welcome && (<section className="welcome" aria-label="Getting started">
            <div>
              <h2>Welcome to SafeRoute</h2>
              <p>See how a network keeps emergency communication alive when parts of it fail.</p>
              <ol>
                <li><b>Start the tour</b> in the left panel and press <b>Run this step</b> each time.</li>
                <li><b>Watch the map</b>: packets move, links turn red when they fail, routes change.</li>
                <li><b>Then experiment</b>: send traffic, trigger a disaster, or click any node to fail it.</li>
              </ol>
            </div>
            <button className="welcome-close" onClick={hideWelcome} aria-label="Dismiss welcome message"><X size={16}/></button>
          </section>)}
          <MetricsDashboard metrics={metrics} topology={topology}/>
          <NetworkGraph topology={topology} selection={selection} busy={busy} onSelect={setSelection} onAddNode={addNode} onConnect={connectNodes} onMoveNode={(id, x, y) => void mutate(() => api.updateNode(id, { x, y }))} onFailNode={(id) => void mutate(() => api.failNode(id))} onRecoverNode={(id) => void mutate(() => api.recoverNode(id))} onDeleteNode={(id) => void mutate(() => api.deleteNode(id))} onFailLink={(id) => void mutate(() => api.failLink(id))} onRecoverLink={(id) => void mutate(() => api.recoverLink(id))} onDeleteLink={(id) => void mutate(() => api.deleteLink(id))} onUpdateLink={(id, bandwidth, latency) => void mutate(() => api.updateLink(id, { bandwidth, latency }))}/>
          <EventLog events={events} packets={topology.packets}/>
        </main>
      </div>
    </div>);
}
export default App;
