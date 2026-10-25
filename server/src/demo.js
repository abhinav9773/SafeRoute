// Run a small, reproducible disaster and restoration demonstration (terminal).
import { Link, Network, Simulator } from './engine.js';

const sim = new Simulator(new Network(['Hospital', 'Router', 'Backup', 'Rescue'], [
  new Link('primary', 'Hospital', 'Router'),
  new Link('uplink', 'Router', 'Rescue'),
  new Link('backup', 'Hospital', 'Backup', 1024, 2),
  new Link('backup-uplink', 'Backup', 'Rescue'),
]), { congestionWeight: 0.25 });
sim.inject('Hospital', 'Rescue');
sim.inject('Hospital', 'Rescue', 'ambulance');
sim.step();
sim.setLinkActive('primary', false);
sim.inject('Hospital', 'Rescue', 'hospital');
sim.step(7);
sim.setLinkActive('primary', true);
sim.inject('Hospital', 'Rescue', 'rescue');
sim.step(5);
console.log(JSON.stringify(sim.snapshot(), null, 2));
