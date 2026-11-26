import {bootDemo} from './demo';
import {bootGame} from './game';
import './view/farm.css';
import './ui/farm-ui.css';

const mount = document.getElementById('root');
if (!mount) throw new Error('Missing farm view root');

const query = new URLSearchParams(location.search);
const boot = query.has('render-review') ? bootDemo(mount) : bootGame(mount, query.has('facilitator'));
void boot.catch((error: unknown) => {
  console.error(error);
  mount.textContent = error instanceof Error ? error.message : 'The farm could not start.';
});
