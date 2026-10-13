#!/usr/bin/env node
/**
 * SPA Bundler for SuperMemo WebView
 * 
 * Generates standalone HTM files from webpack bundles for use with SM20
 * This allows the React app to be embedded directly in SuperMemo's WebView
 * 
 * Usage:
 * node scripts/create-spa.js [target] [output]
 * 
 * Examples:
 * node scripts/create-spa.js ie11 dist/smplayer-ie11.htm
 * node scripts/create-spa.js webview2 dist/smplayer-webview2.htm
 */

const fs = require('fs');
const path = require('path');

const target = process.argv[2] || 'ie11';
const outputPath = process.argv[3] || `dist/smplayer-${target}.htm`;

// Resolve bundle paths
const bundleDir = target === 'webview2' ? 'dist/webview2' : 'dist/ie11';
const smplayerBundle = path.join(bundleDir, 'smplayer.bundle.js');
const homeBundle = path.join(bundleDir, 'home.bundle.js');

if (!fs.existsSync(smplayerBundle)) {
  console.error(`Error: Bundle not found at ${smplayerBundle}`);
  console.error(`Make sure to build the project first: TARGET=${target} pnpm run build`);
  process.exit(1);
}

// Read bundle contents
const smplayerCode = fs.readFileSync(smplayerBundle, 'utf-8');
const homeCode = fs.existsSync(homeBundle) ? fs.readFileSync(homeBundle, 'utf-8') : '';

// Generate HTML with embedded scripts
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SuperMemo ${target === 'webview2' ? 'WebView2' : 'IE11'} Player</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    #root { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <!-- Root div for React -->
  <div id="root"></div>
  
  <!-- Embedded SuperMemo bridge for communication -->
  <script>
    // Global configuration
    window.BUILD_TARGET = '${target}';
    window.BUNDLE_MODE = 'spa';
    
    // Detect SM input elements if running in SM18 (IE11)
    // These are created dynamically if not present
    if (typeof window.MSInputMethodContext !== 'undefined' && document.documentMode) {
      // SM18 mode - ensure input elements exist
      const inputs = [
        { id: 'videoid', value: '' },
        { id: 'resumevideoat', value: '0:00:00' },
        { id: 'startvideoat', value: '0:00:00' },
        { id: 'stopvideoat', value: '0:00:00' },
        { id: 'imposeboundries', value: '0' }
      ];
      
      inputs.forEach(input => {
        if (!document.getElementById(input.id)) {
          const elem = document.createElement('input');
          elem.id = input.id;
          elem.type = 'hidden';
          elem.value = input.value;
          document.body.appendChild(elem);
        }
      });
    }
  </script>
  
  <!-- Embedded smplayer bundle -->
  <script>
${smplayerCode}
  </script>
  
  ${homeCode ? `<!-- Embedded home bundle -->
  <script>
${homeCode}
  </script>` : ''}
  
  <!-- Initialize React app -->
  <script>
    // The webpack bundles expect certain globals to be available
    // These are injected by webpack's DefinePlugin
    if (typeof BUILD_TARGET === 'undefined') {
      window.BUILD_TARGET = '${target}';
    }
    if (typeof SERVER_CONFIG === 'undefined') {
      window.SERVER_CONFIG = {
        url: 'localhost',
        port: 3000
      };
    }
    
    // Notify console that SPA is loaded
    console.log('SuperMemo ${target} SPA loaded');
    console.log('Build Target:', window.BUILD_TARGET);
  </script>
</body>
</html>
`;

// Ensure output directory exists
const outputDir = path.dirname(outputPath);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Write the HTML file
fs.writeFileSync(outputPath, html, 'utf-8');
console.log(`✓ SPA generated: ${path.resolve(outputPath)}`);
console.log(`  Target: ${target}`);
console.log(`  Size: ${(html.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`\nTo use with SuperMemo 20:`);
console.log(`  1. Copy to: C:\\SuperMemo\\bin\\YouTube\\smplayer-${target}.htm`);
console.log(`  2. Update WebView.htm to load this file`);
