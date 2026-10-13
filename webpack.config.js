const mode = process.env.NODE_ENV || 'development';
var environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';

// webpack.config.js
const SERVER_CONFIG = require('./server-config.js');

// Temporary workaround for 'browserslist' bug that is being patched in the near future
// const target = process.env.NODE_ENV === 'production' ? 'browserslist' : 'web';

const path = require('path');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const webpack = require('webpack');

/**
 * Dual-target webpack configuration
 * Supports:
 * - IE11 build (default): targets ES5 with full polyfills
 * - WebView2 build: targets modern Chromium with minimal polyfills
 * 
 * Usage:
 * pnpm run build                    # IE11 build
 * NODE_ENV=production pnpm run build # IE11 production
 * TARGET=webview2 pnpm run build     # WebView2 build
 * TARGET=webview2 NODE_ENV=production pnpm run build # WebView2 production
 */

const buildTarget = process.env.TARGET || 'ie11';
console.log(`Building for target: ${buildTarget}`);

const baseConfig = {
  entry : {
    smplayer: './src/app/templates/smplayer/index.tsx',
    home: './src/app/templates/home/index.tsx',
    archive: './src/app/templates/archive/index.tsx',
  },
  mode: mode,
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: path.resolve(__dirname, 'node_modules'),
        use: {
          loader: 'babel-loader',
          options: {
            envName: buildTarget === 'webview2' ? 'webview2' : undefined,
          },
        },
      },
      {
        test: /\.(ts|tsx)$/,
        exclude: path.resolve(__dirname, 'node_modules'),
        use: [
          {
            loader: 'babel-loader',
            options: {
              envName: buildTarget === 'webview2' ? 'webview2' : undefined,
            },
          },
          'ts-loader'
        ],
      },
      {  
        test: /\.css$/,
        use: ['style-loader', 
          {
            loader: 'css-loader',
            options: {
              modules: true,
            },
          }
        ],
      }
    ]
  },
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx']
  },
  plugins: [
    new ForkTsCheckerWebpackPlugin(),
    new webpack.DefinePlugin({
      'SERVER_CONFIG': SERVER_CONFIG[environment],
      'BUILD_TARGET': JSON.stringify(buildTarget),
    })
  ],
  devtool: 'cheap-module-source-map',
};

// Target-specific configuration
const targetConfigs = {
  ie11: {
    output: {
      filename: 'ie11/[name].bundle.js',
      chunkFilename: 'ie11/[name].chunk.js'
    },
    target: ['web', 'es5'],
  },
  webview2: {
    output: {
      filename: 'webview2/[name].bundle.js',
      chunkFilename: 'webview2/[name].chunk.js'
    },
    target: ['web', 'es2017'],
  }
};

const config = buildTarget === 'webview2' ? targetConfigs.webview2 : targetConfigs.ie11;

module.exports = {
  ...baseConfig,
  ...config,
};
