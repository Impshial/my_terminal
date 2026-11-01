import type { Bridge } from '../shared/schema';
declare global {
  interface Window {
    myterminal: Bridge;
  }
}
