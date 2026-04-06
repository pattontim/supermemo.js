/**
 * SuperMemo Bridge Abstraction
 * Unified interface for communicating with both SM18 (IE11) and SM20 (WebView2)
 * 
 * SM18: Uses DOM input fields that SuperMemo reads directly
 * SM20: Uses window.chrome.webview.postMessage for structured communication
 */

export interface ClipData {
  videoId: string;
  resume: string;
  start: string;
  stop: string;
  extracts: Array<{ value: string; label: string } | { name: string; value: string }>;
}

export interface FocusInfo {
  isInput: boolean;
}

export interface SuperMemoMessage {
  type: string;
  [key: string]: any;
}

export type RuntimeEnvironment = 'ie11' | 'webview2' | 'dev';

class SuperMemoBridge {
  private runtime: RuntimeEnvironment = 'dev';
  private listeners: Map<string, ((msg: SuperMemoMessage) => void)[]> = new Map();

  constructor() {
    this.detectRuntime();
    this.setupListeners();
  }

  /**
   * Detect runtime environment
   * - IE11: window.MSInputMethodContext && document.documentMode
   * - WebView2: window.chrome?.webview?.postMessage exists
   * - Dev: neither (fallback to console logging)
   */
  private detectRuntime(): void {
    // Check for WebView2
    if ((window as any).chrome?.webview?.postMessage) {
      this.runtime = 'webview2';
      console.log('[SuperMemo Bridge] Detected SM20 WebView2 environment');
    }
    // Check for IE11
    else if ((window as any).MSInputMethodContext && (document as any).documentMode) {
      this.runtime = 'ie11';
      console.log('[SuperMemo Bridge] Detected SM18 IE11 environment');
    } else {
      this.runtime = 'dev';
      console.log('[SuperMemo Bridge] Dev/Browser mode - messages logged to console');
    }
  }

  /**
   * Set up listener for incoming messages from SuperMemo (SM20 only)
   */
  private setupListeners(): void {
    if (this.runtime !== 'webview2') return;

    try {
      (window as any).chrome.webview.addEventListener('message', (event: any) => {
        try {
          const msg = typeof event.data === 'string' 
            ? JSON.parse(event.data) 
            : event.data;
          
          const handlers = this.listeners.get(msg.type) || [];
          handlers.forEach(handler => handler(msg));
          
          console.log('[SM Bridge ← SuperMemo]', msg.type, msg);
        } catch (err) {
          console.error('[SM Bridge] Message parsing error:', err);
        }
      });
    } catch (err) {
      console.error('[SM Bridge] Failed to setup WebView2 listener:', err);
    }
  }

  /**
   * Register a handler for incoming messages (SM20 only)
   */
  public onMessage(type: string, handler: (msg: SuperMemoMessage) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(handler);
  }

  /**
   * Send clip data to SuperMemo
   * SM18: Writes to DOM input elements
   * SM20: Sends youtubeData message via postMessage
   */
  public sendClipData(clipData: ClipData): void {
    if (this.runtime === 'webview2') {
      this.sendWebView2Message('youtubeData', clipData);
    } else if (this.runtime === 'ie11') {
      this.writeToDOM(clipData);
    } else {
      console.log('[→ SuperMemo] youtubeData', clipData);
    }
  }

  /**
   * Send focus info to SuperMemo (SM20 only)
   */
  public sendFocusInfo(isInput: boolean): void {
    if (this.runtime === 'webview2') {
      this.sendWebView2Message('focusInfo', { isInput });
    } else if (this.runtime === 'dev') {
      console.log('[→ SuperMemo] focusInfo', { isInput });
    }
    // IE11 doesn't need explicit focus messages
  }

  /**
   * Send command to SuperMemo (SM20 only)
   */
  public sendCommand(command: 'ESCAPE' | 'FOCUS_SUPERMEMO'): void {
    if (this.runtime === 'webview2') {
      this.sendWebView2Message('command', { command });
    } else if (this.runtime === 'dev') {
      console.log('[→ SuperMemo] command', { command });
    }
    // IE11 doesn't need explicit commands
  }

  /**
   * Internal: Send message via WebView2 postMessage
   */
  private sendWebView2Message(type: string, payload: any): void {
    try {
      const msg = JSON.stringify({ type, payload });
      (window as any).chrome.webview.postMessage(msg);
      console.log('[SM Bridge → WebView2]', type, payload);
    } catch (err) {
      console.error('[SM Bridge] WebView2 send failed:', err);
    }
  }

  /**
   * Internal: Write clip data to DOM input elements (SM18 only)
   */
  private writeToDOM(clipData: ClipData): void {
    try {
      const videoid = document.getElementById('videoid') as HTMLInputElement;
      const resumevideoat = document.getElementById('resumevideoat') as HTMLInputElement;
      const startvideoat = document.getElementById('startvideoat') as HTMLInputElement;
      const stopvideoat = document.getElementById('stopvideoat') as HTMLInputElement;

      if (!videoid || !resumevideoat || !startvideoat || !stopvideoat) {
        throw new Error('Required SM18 DOM inputs not found');
      }

      videoid.value = clipData.videoId;
      resumevideoat.value = clipData.resume;
      startvideoat.value = clipData.start;
      stopvideoat.value = clipData.stop;

      console.log('[SM Bridge → DOM]', clipData);
    } catch (err) {
      console.error('[SM Bridge] DOM write failed:', err);
    }
  }

  /**
   * Get current runtime environment
   */
  public getRuntime(): RuntimeEnvironment {
    return this.runtime;
  }

  /**
   * Check if running in WebView2
   */
  public isWebView2(): boolean {
    return this.runtime === 'webview2';
  }

  /**
   * Check if running in IE11
   */
  public isIE11(): boolean {
    return this.runtime === 'ie11';
  }

  /**
   * Check if running in dev/browser
   */
  public isDevMode(): boolean {
    return this.runtime === 'dev';
  }
}

// Singleton instance
let bridge: SuperMemoBridge | null = null;

/**
 * Get or create the SuperMemo bridge instance
 */
export function getBridge(): SuperMemoBridge {
  if (!bridge) {
    bridge = new SuperMemoBridge();
  }
  return bridge;
}

/**
 * Convenience functions matching the bridge interface
 */
export const supermemo = {
  getRuntime: () => getBridge().getRuntime(),
  isWebView2: () => getBridge().isWebView2(),
  isIE11: () => getBridge().isIE11(),
  isDevMode: () => getBridge().isDevMode(),
  sendClipData: (data: ClipData) => getBridge().sendClipData(data),
  sendFocusInfo: (isInput: boolean) => getBridge().sendFocusInfo(isInput),
  sendCommand: (cmd: 'ESCAPE' | 'FOCUS_SUPERMEMO') => getBridge().sendCommand(cmd),
  onMessage: (type: string, handler: (msg: SuperMemoMessage) => void) => getBridge().onMessage(type, handler),
};
