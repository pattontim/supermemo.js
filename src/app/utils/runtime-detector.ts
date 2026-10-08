/**
 * Runtime Environment Detection
 * Determines browser capabilities and configures player accordingly
 */

export interface PlayerConfig {
  dashVersion: string;
  hlsVersion: string;
}

export interface BrowserCapabilities {
  supportsClipboard: boolean;
  supportsModernES: boolean;
  dashVersion: string;
  hlsVersion: string;
}

class RuntimeDetector {
  private capabilities: BrowserCapabilities | null = null;

  /**
   * Detect browser capabilities
   */
  detectCapabilities(): BrowserCapabilities {
    if (this.capabilities) {
      return this.capabilities;
    }

    const isIE11 = !!(window as any).MSInputMethodContext && !!(document as any).documentMode;
    const isWebView2 = !!(window as any).chrome?.webview?.postMessage;
    const isSecureContext = window.isSecureContext;

    // WebView2 and dev browsers support modern clipboard API
    const supportsClipboard = !isIE11 && isSecureContext;

    // Only WebView2 and modern browsers should use latest library versions
    const supportsModernES = isWebView2 || (!isIE11 && !navigator.userAgent.includes('Trident'));

    const dashVersion = supportsModernES ? '4.7.4' : '4.5.2';
    const hlsVersion = supportsModernES ? '1.5.1' : '1.2.0';

    this.capabilities = {
      supportsClipboard,
      supportsModernES,
      dashVersion,
      hlsVersion,
    };

    console.log('[Runtime] Capabilities:', this.capabilities);
    return this.capabilities;
  }

  /**
   * Get player configuration based on runtime
   */
  getPlayerConfig(): PlayerConfig {
    const caps = this.detectCapabilities();
    return {
      dashVersion: caps.dashVersion,
      hlsVersion: caps.hlsVersion,
    };
  }

  /**
   * Copy text using appropriate method
   */
  async copyToClipboard(text: string): Promise<boolean> {
    const caps = this.detectCapabilities();

    // Use modern Clipboard API if available
    if (caps.supportsClipboard) {
      try {
        await navigator.clipboard.writeText(text);
        console.log('[Runtime] Text copied via Clipboard API');
        return true;
      } catch (err) {
        console.error('[Runtime] Clipboard API failed:', err);
        // Fall through to legacy method
      }
    }

    // Fallback to legacy execCommand
    return this.copyViaExecCommand(text);
  }

  /**
   * Legacy copy method for IE11 and non-secure contexts
   */
  private copyViaExecCommand(text: string): boolean {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      
      const success = document.execCommand('copy');
      document.body.removeChild(textarea);
      
      if (success) {
        console.log('[Runtime] Text copied via execCommand (legacy)');
      }
      return success;
    } catch (err) {
      console.error('[Runtime] Legacy copy failed:', err);
      return false;
    }
  }

  /**
   * Get browser name from user agent
   */
  getBrowserName(): string {
    const ua = navigator.userAgent;
    if (ua.includes('Trident')) return 'IE';
    if (ua.includes('Edge')) return 'Edge';
    if (ua.includes('Chrome')) return 'Chrome';
    if (ua.includes('Firefox')) return 'Firefox';
    if (ua.includes('Safari')) return 'Safari';
    return 'Unknown';
  }

  /**
   * Determine which manifest target to request from server
   */
  getStreamTarget(): 'IE' | 'webview2' | 'default' {
    const isIE11 = !!(window as any).MSInputMethodContext && !!(document as any).documentMode;
    const isWebView2 = !!(window as any).chrome?.webview?.postMessage;

    if (isIE11) return 'IE';
    if (isWebView2) return 'webview2';
    return 'default';
  }
}

// Singleton instance
let detector: RuntimeDetector | null = null;

/**
 * Get or create detector instance
 */
export function getRuntime(): RuntimeDetector {
  if (!detector) {
    detector = new RuntimeDetector();
  }
  return detector;
}

/**
 * Convenience export
 */
export const runtime = {
  detectCapabilities: () => getRuntime().detectCapabilities(),
  getPlayerConfig: () => getRuntime().getPlayerConfig(),
  copyToClipboard: (text: string) => getRuntime().copyToClipboard(text),
  getBrowserName: () => getRuntime().getBrowserName(),
  getStreamTarget: () => getRuntime().getStreamTarget(),
};
