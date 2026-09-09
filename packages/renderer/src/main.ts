import { mount } from 'svelte';
import '@feathertree/base-ui/src/base.css';
import './theme/tokens.css';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('#app が見つかりません');

mount(App, { target });
