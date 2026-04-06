/**
 * Build Configuration for SM20 WebView2 Support
 * 
 * Supports multiple build targets and output modes:
 * 
 * Build Targets:
 * - ie11       : SuperMemo 18 (IE11) - legacy environment
 * - webview2   : SuperMemo 20 (WebView2) - modern Chromium-based
 * - both       : Both targets in a single build
 * 
 * Output Modes:
 * - http       : Served via HTTP from local dev server (default)
 * - spa        : Single Page Application HTM file for local execution
 * - embedded   : Embedded in SuperMemo bin/YouTube folder
 */

export interface BuildConfig {
  target: 'ie11' | 'webview2' | 'both';
  outputMode: 'http' | 'spa' | 'embedded';
  enablePolyfills: boolean;
  minifyOutput: boolean;
  sourceMap: boolean;
}

export const defaultConfig: BuildConfig = {
  target: 'both',
  outputMode: 'http',
  enablePolyfills: true,
  minifyOutput: false,
  sourceMap: true,
};

/**
 * Get config from environment variables or defaults
 */
export function getConfig(): BuildConfig {
  return {
    target: (process.env.BUILD_TARGET as any) || defaultConfig.target,
    outputMode: (process.env.OUTPUT_MODE as any) || defaultConfig.outputMode,
    enablePolyfills: process.env.ENABLE_POLYFILLS !== 'false',
    minifyOutput: process.env.NODE_ENV === 'production',
    sourceMap: process.env.SOURCEMAP !== 'false',
  };
}

/**
 * Configuration presets for common scenarios
 */
export const presets = {
  // Development: both targets with full source maps
  dev: {
    target: 'both' as const,
    outputMode: 'http' as const,
    sourceMap: true,
    minifyOutput: false,
  },
  
  // Production: both targets, minified, SPA mode for deployment
  prodSpa: {
    target: 'both' as const,
    outputMode: 'spa' as const,
    sourceMap: false,
    minifyOutput: true,
  },
  
  // Production: both targets, minified, HTTP served
  prodHttp: {
    target: 'both' as const,
    outputMode: 'http' as const,
    sourceMap: false,
    minifyOutput: true,
  },
  
  // Legacy IE11 only
  ie11Only: {
    target: 'ie11' as const,
    outputMode: 'http' as const,
    sourceMap: true,
    minifyOutput: false,
  },
  
  // Modern WebView2 only (faster builds for testing)
  webview2Only: {
    target: 'webview2' as const,
    outputMode: 'http' as const,
    sourceMap: true,
    minifyOutput: false,
  },
};
