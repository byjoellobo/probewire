import '@fontsource/barlow-semi-condensed/400.css';
import '@fontsource/barlow-semi-condensed/500.css';
import '@fontsource/barlow-semi-condensed/600.css';
import '@fontsource/barlow-semi-condensed/700.css';
import './styles.css';
import { render } from 'preact';
import { App } from './app/App';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app element');
render(<App />, root);
