import { Activity, Gauge, PackageCheck, PackageX, Timer, Zap, } from 'lucide-react';
function formatLatency(value) {
    return value === null ? '—' : `${value.toFixed(2)} s`;
}
function formatThroughput(bitsPerSecond) {
    if (bitsPerSecond >= 1_000_000)
        return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`;
    if (bitsPerSecond >= 1_000)
        return `${(bitsPerSecond / 1_000).toFixed(2)} Kbps`;
    return `${bitsPerSecond.toFixed(0)} bps`;
}
export function MetricsDashboard({ metrics, topology, }) {
    const cards = [
        { label: 'Average delay', hint: 'Time from sending to delivery', value: formatLatency(metrics.average_latency_seconds), icon: Timer },
        { label: 'Emergency delay', hint: 'Should stay lower than normal', value: formatLatency(metrics.emergency_packet_latency_seconds), icon: Zap, tone: 'amber' },
        { label: 'Delivered', hint: 'Packets that arrived', value: metrics.packets_delivered.toString(), icon: PackageCheck, tone: 'green' },
        { label: 'Lost', hint: `${metrics.packet_loss_percentage.toFixed(1)}% of all packets`, value: metrics.packets_dropped.toString(), icon: PackageX, tone: 'red' },
        { label: 'Speed', hint: 'Delivered data per second', value: formatThroughput(metrics.throughput_bps), icon: Activity },
    ];
    return (<section className="metrics-panel panel">
      <div className="panel-heading">
        <div>
          <h2>Live results</h2>
          <p className="panel-sub">Measured from the simulation as it runs.</p>
        </div>
        <span className="sim-clock">T+{metrics.elapsed_seconds}s</span>
      </div>
      <div className="metric-layout">
        <div className="metric-cards">
          {cards.map(({ label, hint, value, icon: Icon, tone }) => (<article className={`metric-card ${tone ? `metric-card--${tone}` : ''}`} key={label} title={hint}>
              <Icon size={17}/>
              <span>{label}</span>
              <strong>{value}</strong>
              <small>{hint}</small>
            </article>))}
        </div>
        <div className="utilization-card">
          <div className="utilization-card__heading">
            <span><Gauge size={16}/> How busy each link is</span>
            <small>share of capacity used so far</small>
          </div>
          <div className="utilization-list">
            {topology.links.map((link) => {
            const utilization = metrics.links[link.id]?.utilization;
            const percent = utilization === null || utilization === undefined
                ? 0
                : Math.min(100, utilization * 100);
            return (<div className="utilization-row" key={link.id}>
                  <div>
                    <span>{link.id}</span>
                    <small>{utilization === null || utilization === undefined ? 'Not used yet' : `${percent.toFixed(1)}%`}</small>
                  </div>
                  <div className="utilization-track">
                    <i className={link.status === 'failed' ? 'is-failed' : ''} style={{ width: `${percent}%` }}/>
                  </div>
                </div>);
        })}
          </div>
        </div>
      </div>
    </section>);
}
