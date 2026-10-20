import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function (pi: ExtensionAPI) {
  pi.registerCommand('pi-a2a-load-probe', { description: 'No-model local load assertion', handler: async () => {
    const names = pi.getAllTools().map(x => x.name).filter(x => x.startsWith('a2a_')).sort();
    pi.sendMessage({ customType: 'pi-a2a-load-probe', content: JSON.stringify(names), display: false, details: { names } });
  } });
}
