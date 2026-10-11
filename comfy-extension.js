import { app } from '../../scripts/app.js';
app.registerExtension({
  name: 'dsh.ComfyUI.LiveBridge',
  async setup() {
    async function connect() {
      if (window.__DSH_COMFYUI_BRIDGE_ACTIVE__) return;
      const configured = new URLSearchParams(location.search).get('dsh_bridge');
      const bridgeBase = configured || __DSH_DEFAULT_BRIDGE__;
      try {
        const response = await fetch(bridgeBase + '/__dsh_comfyui/bootstrap');
        if (!response.ok) throw new Error('Bridge unavailable');
        window.__DSH_COMFYUI_BOOTSTRAP__ = await response.json();
        const script = document.createElement('script');
        script.src = bridgeBase + '/__dsh_comfyui/bridge.js';
        script.onerror = () => setTimeout(connect, 3000);
        document.head.appendChild(script);
      } catch { setTimeout(connect, 3000); }
    }
    connect();
  }
});
