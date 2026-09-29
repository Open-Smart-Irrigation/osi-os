import Reveal from 'reveal.js';
import './reveal-example.css';
import 'reveal.js/reveal.css';
import 'reveal.js/theme/white.css';
import {connectOsiDemo} from './reveal-bridge.js';
const deck = new Reveal({width:1280, height:720, margin:0, hash:true, transition:'none', keyboardCondition:'focused', embedded:true});
connectOsiDemo(deck, document.querySelector('#osi-demo'));
void deck.initialize().then(() => {
  const element = deck.getRevealElement();
  element.tabIndex = 0;
  element.focus();
});
