import { useState } from 'react';
import { Ambulance, CloudLightning, Send, } from 'lucide-react';
const emergencyServices = [
    'emergency', 'hospital', 'ambulance', 'police', 'fire', 'rescue',
];
const disasterTypes = ['earthquake', 'flood', 'cyclone', 'cyberattack'];
const intensities = ['low', 'medium', 'high'];
export function ControlPanel(props) {
    const [disaster, setDisaster] = useState('earthquake');
    const [intensity, setIntensity] = useState('medium');
    const noRouteEndpoints = !props.source || !props.destination;
    return (<aside className="controls-panel panel">
      <div className="panel-heading">
        <div><h2>Controls</h2><p className="panel-sub">Press Start in the top bar, then send traffic.</p></div>
      </div>

      <section className="control-section">
        <h3>1. Send traffic</h3>
        <div className="field-row">
          <label>From
            <select value={props.source} onChange={(event) => props.onSourceChange(event.target.value)}>
              {props.nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>To
            <select value={props.destination} onChange={(event) => props.onDestinationChange(event.target.value)}>
              {props.nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        </div>
        <div className="button-stack">
          <button className="button button--normal" disabled={props.busy || noRouteEndpoints} onClick={() => props.onAction('normal')} title="Ordinary traffic. It waits in line.">
            <Send size={16}/> Send normal packet
          </button>
          <button className="button button--emergency" disabled={props.busy || noRouteEndpoints} onClick={() => props.onAction('emergency')} title="Emergency traffic jumps ahead of normal packets.">
            <Ambulance size={17}/> Send emergency packet
          </button>
        </div>
        <details className="more-options">
          <summary>More options</summary>
          <label>Emergency service type
            <select value={props.service} onChange={(event) => props.onServiceChange(event.target.value)}>
              {emergencyServices.map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}
            </select>
          </label>
        </details>
      </section>

      <section className="control-section">
        <h3>2. Break something</h3>
        <p>Pick a disaster and how severe it is. It fails real nodes and links so you can watch the network adapt.</p>
        <div className="chips" role="radiogroup" aria-label="Disaster type">
          {disasterTypes.map((item) => (<button key={item} role="radio" aria-checked={disaster === item} className={`chip ${disaster === item ? 'is-active' : ''}`} onClick={() => setDisaster(item)}>
              {item[0].toUpperCase() + item.slice(1)}
            </button>))}
        </div>
        <div className="chips chips--three" role="radiogroup" aria-label="Intensity">
          {intensities.map((item) => (<button key={item} role="radio" aria-checked={intensity === item} className={`chip ${intensity === item ? 'is-active' : ''}`} onClick={() => setIntensity(item)}>
              {item[0].toUpperCase() + item.slice(1)}
            </button>))}
        </div>
        <button className="button button--danger" disabled={props.busy} onClick={() => props.onDisaster(disaster, intensity)}>
          <CloudLightning size={17}/> Trigger {disaster} ({intensity})
        </button>
      </section>
    </aside>);
}
