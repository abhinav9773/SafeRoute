import { memo, useEffect, useMemo, useState } from 'react';
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, useEdgesState, useNodesState, } from '@xyflow/react';
import { Ambulance, Flame, Hospital, LifeBuoy, Network as NetworkIcon, Check, Pencil, Plus, RadioTower, Router, Shield, ShieldAlert, Trash2, Unplug, Zap, } from 'lucide-react';
const NODE_ICONS = {
    router: Router,
    switch: NetworkIcon,
    hospital: Hospital,
    police: Shield,
    fire: Flame,
    rescue: LifeBuoy,
    ambulance: Ambulance,
};
const TYPE_LABELS = {
    router: 'Router',
    switch: 'Switch',
    hospital: 'Hospital',
    police: 'Police Station',
    fire: 'Fire Station',
    rescue: 'Rescue Center',
    ambulance: 'Ambulance Station',
};
const ServiceNode = memo(({ data, selected }) => {
    const Icon = data.failed ? ShieldAlert : NODE_ICONS[data.nodeType];
    return (<div className={`router-node ${data.failed ? 'router-node--failed' : ''} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="router-handle"/>
      <div className="router-node__icon"><Icon size={20}/></div>
      <div className="router-node__copy">
        <strong>{data.label}</strong>
        <span>{TYPE_LABELS[data.nodeType]} · {data.id}</span>
      </div>
      {data.packets.length > 0 && (<div className="packet-cluster" aria-label={`${data.packets.length} packets at node`}>
          {data.packets.slice(0, 4).map((packet) => (<span key={packet.id} className={`packet-dot packet-dot--${packet.packet_class}`} title={`${packet.packet_class} packet P${packet.id}`}>
              {packet.packet_class === 'emergency' ? <Zap size={8}/> : null}
            </span>))}
          {data.packets.length > 4 && <small>+{data.packets.length - 4}</small>}
        </div>)}
      <Handle type="source" position={Position.Bottom} className="router-handle"/>
    </div>);
});
ServiceNode.displayName = 'ServiceNode';
const nodeTypes = { service: ServiceNode };
function routeContainsLink(route, link) {
    return route.some((node, index) => {
        const next = route[index + 1];
        return (node === link.source && next === link.destination)
            || (node === link.destination && next === link.source);
    });
}
function packetLabel(packets) {
    const normal = packets.filter((packet) => packet.packet_class === 'normal').length;
    const emergency = packets.length - normal;
    return [normal ? `● N${normal}` : '', emergency ? `⚡ E${emergency}` : '']
        .filter(Boolean).join('  ');
}
function radialPosition(index, count) {
    if (count === 1)
        return { x: 300, y: 170 };
    const angle = (2 * Math.PI * index) / Math.max(count, 1) - Math.PI / 2;
    return { x: 300 + Math.cos(angle) * 235, y: 190 + Math.sin(angle) * 155 };
}
function ComponentInspector(props) {
    const node = props.selection?.kind === 'node'
        ? props.topology.nodes.find((item) => item.id === props.selection?.id) : undefined;
    const link = props.selection?.kind === 'link'
        ? props.topology.links.find((item) => item.id === props.selection?.id) : undefined;
    const [bandwidth, setBandwidth] = useState('1024');
    const [latency, setLatency] = useState('1');
    useEffect(() => {
        if (link) {
            setBandwidth(String(link.bandwidth));
            setLatency(String(link.latency));
        }
    }, [link?.bandwidth, link?.id, link?.latency]);
    if (!node && !link) {
        return (<aside className="component-inspector">
        <span className="eyebrow">Inspector</span>
        <div className="inspector-empty">
          Nothing selected. Click a node or a link on the map to see its details and test what happens when it fails.
        </div>
      </aside>);
    }
    if (node) {
        const Icon = NODE_ICONS[node.type];
        const connectedLinks = props.topology.links.filter((item) => (item.source === node.id || item.destination === node.id)).length;
        const packetsHere = props.topology.packets.filter((packet) => packet.node === node.id).length;
        return (<aside className="component-inspector">
        <span className="eyebrow">Node inspector</span>
        <div className="inspector-title"><Icon size={19}/><strong>{node.name}</strong></div>
        <dl className="inspector-facts">
          <div><dt>ID</dt><dd>{node.id}</dd></div>
          <div><dt>Type</dt><dd>{TYPE_LABELS[node.type]}</dd></div>
          <div><dt>Status</dt><dd className={`status-text status-text--${node.status}`}>{node.status}</dd></div>
          <div><dt>Connected links</dt><dd>{connectedLinks}</dd></div>
          <div><dt>Packets here</dt><dd>{packetsHere}</dd></div>
          <div><dt>Position</dt><dd>{Math.round(node.x ?? 0)}, {Math.round(node.y ?? 0)}</dd></div>
        </dl>
        <div className="inspector-actions">
          {node.status === 'operational' ? (<button className="button button--danger" disabled={props.busy} onClick={() => props.onFailNode(node.id)}>
              <Unplug size={15}/> Fail node
            </button>) : (<button className="button button--recover" disabled={props.busy} onClick={() => props.onRecoverNode(node.id)}>
              <RadioTower size={15}/> Recover node
            </button>)}
          {props.editing && <button className="button button--danger" disabled={props.busy} onClick={() => props.onDeleteNode(node.id)}>
            <Trash2 size={15}/> Delete node
          </button>}
        </div>
      </aside>);
    }
    const utilization = link?.utilization == null ? 'No measured capacity' : `${(link.utilization * 100).toFixed(1)}%`;
    const validProperties = Number(bandwidth) > 0 && Number(latency) > 0;
    return (<aside className="component-inspector">
      <span className="eyebrow">Link inspector</span>
      <div className="inspector-title"><NetworkIcon size={19}/><strong>{link?.id}</strong></div>
      <dl className="inspector-facts">
        <div><dt>Endpoints</dt><dd>{link?.source} ↔ {link?.destination}</dd></div>
        <div><dt>Status</dt><dd className={`status-text status-text--${link?.status}`}>{link?.status}</dd></div>
        <div><dt>Utilization</dt><dd>{utilization}</dd></div>
        <div><dt>Queue</dt><dd>{link?.queue.length ?? 0} packets</dd></div>
      </dl>
      <label>Bandwidth (bytes/s)<input type="number" min="1" value={bandwidth} onChange={(event) => setBandwidth(event.target.value)}/></label>
      <label>Latency (seconds)<input type="number" min="1" value={latency} onChange={(event) => setLatency(event.target.value)}/></label>
      <div className="inspector-actions">
        <button className="button" disabled={props.busy || !validProperties} onClick={() => link && props.onUpdateLink(link.id, Number(bandwidth), Number(latency))}>Save link properties</button>
        {link?.status === 'operational' ? (<button className="button button--danger" disabled={props.busy} onClick={() => props.onFailLink(link.id)}>
            <Unplug size={15}/> Fail link
          </button>) : (<button className="button button--recover" disabled={props.busy} onClick={() => link && props.onRecoverLink(link.id)}>
            <RadioTower size={15}/> Recover link
          </button>)}
        {props.editing && <button className="button button--danger" disabled={props.busy} onClick={() => link && props.onDeleteLink(link.id)}>
          <Trash2 size={15}/> Delete link
        </button>}
      </div>
    </aside>);
}
export function NetworkGraph(props) {
    const { topology, selection } = props;
    const projectedNodes = useMemo(() => topology.nodes.map((node, index) => {
        const fallback = radialPosition(index, topology.nodes.length);
        return {
            id: node.id,
            type: 'service',
            position: { x: node.x ?? fallback.x, y: node.y ?? fallback.y },
            data: {
                id: node.id,
                label: node.name,
                nodeType: node.type,
                failed: node.status === 'failed',
                packets: topology.packets.filter((packet) => packet.node === node.id),
            },
            selected: selection?.kind === 'node' && selection.id === node.id,
            draggable: true,
            selectable: true,
        };
    }), [selection, topology.nodes, topology.packets]);
    const projectedEdges = useMemo(() => topology.links.map((link) => {
        const failed = link.status === 'failed';
        const active = topology.active_routes.some((route) => routeContainsLink(route.route, link));
        const packets = topology.packets.filter((packet) => packet.link === link.id || packet.queued_link === link.id);
        const packetsOnLink = packetLabel(packets);
        return {
            id: link.id,
            source: link.source,
            target: link.destination,
            type: 'smoothstep',
            animated: active && !failed,
            selected: selection?.kind === 'link' && selection.id === link.id,
            label: `${link.latency}s · ${link.bandwidth} B/s${link.queue.length ? ` · Q${link.queue.length}` : ''}${packetsOnLink ? ` · ${packetsOnLink}` : ''}`,
            labelStyle: { fill: '#94A3B8', fontSize: 10, fontWeight: 600 },
            labelBgStyle: { fill: '#1E293B', fillOpacity: 1 },
            labelBgPadding: [6, 4],
            labelBgBorderRadius: 4,
            style: {
                stroke: failed ? '#EF4444' : active ? '#60A5FA' : '#475569',
                strokeWidth: active || (selection?.kind === 'link' && selection.id === link.id) ? 2.5 : 1.5,
                strokeDasharray: failed ? '7 5' : undefined,
            },
        };
    }), [selection, topology.active_routes, topology.links, topology.packets]);
    const [nodes, setNodes, onNodesChange] = useNodesState(projectedNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(projectedEdges);
    useEffect(() => setNodes(projectedNodes), [projectedNodes, setNodes]);
    useEffect(() => setEdges(projectedEdges), [projectedEdges, setEdges]);
    const [editing, setEditing] = useState(false);
    const groups = [
        { title: 'Network', types: ['router', 'switch'] },
        { title: 'Emergency services', types: ['hospital', 'police', 'fire', 'rescue', 'ambulance'] },
    ];
    return (<section className="network-panel panel">
      <div className="panel-heading">
        <div><h2>Network map</h2><p className="panel-sub">{editing
            ? 'Add components below, then drag from one node\'s dot to another to connect them.'
            : 'Click any node or link to inspect it, fail it, or recover it.'}</p></div>
        <div className="network-summary">
          <RadioTower size={15}/>{topology.nodes.length} nodes · {topology.links.length} links
          <button className={`button ${editing ? 'button--primary' : ''}`} onClick={() => setEditing(!editing)} title="Add or remove nodes and links">
            {editing ? <><Check size={15}/> Done editing</> : <><Pencil size={15}/> Edit network</>}
          </button>
        </div>
      </div>
      <div className="topology-editor">
        {editing && <aside className="component-palette">
          <span className="palette-title">Add component</span>
          {groups.map((group) => (<div className="palette-group" key={group.title}>
              <h3>{group.title}</h3>
              {group.types.map((type) => {
                const Icon = NODE_ICONS[type];
                return (<button key={type} disabled={props.busy} onClick={() => props.onAddNode(type)}>
                    <Icon size={15}/><span>{TYPE_LABELS[type]}</span><Plus size={13}/>
                  </button>);
            })}
            </div>))}
        </aside>}
        <div className="network-canvas">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeClick={(_, node) => props.onSelect({ kind: 'node', id: node.id })} onEdgeClick={(_, edge) => props.onSelect({ kind: 'link', id: edge.id })} onPaneClick={() => props.onSelect(null)} onNodeDragStop={(_, node) => props.onMoveNode(node.id, node.position.x, node.position.y)} onConnect={(connection) => {
            if (connection.source && connection.target)
                props.onConnect(connection.source, connection.target);
        }} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }} minZoom={0.35} maxZoom={1.8} proOptions={{ hideAttribution: true }}>
            <Background variant={BackgroundVariant.Dots} color="#334155" gap={22} size={1}/>
            <Controls showInteractive={false} position="bottom-right"/>
          </ReactFlow>
        </div>
        <ComponentInspector {...props} editing={editing}/>
      </div>
      <div className="legend" aria-label="Network legend">
        <span><i className="legend-node legend-node--ok"/>Operational node</span>
        <span><i className="legend-node legend-node--failed"/>Failed node</span>
        <span><i className="legend-line legend-line--ok"/>Operational link</span>
        <span><i className="legend-line legend-line--failed"/>Failed link</span>
        <span><i className="legend-line legend-line--active"/>Route in use</span>
        <span><i className="packet-dot packet-dot--normal"/>Normal packet</span>
        <span><i className="packet-dot packet-dot--emergency"><Zap size={7}/></i>Emergency packet</span>
      </div>
    </section>);
}
