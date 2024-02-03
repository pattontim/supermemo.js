const mode = process.env.NODE_ENV || 'development';
var environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';

// webpack.config.js
const SERVER_CONFIG = require('./server-config.js');

// Temporary workaround for 'browserslist' bug that is being patched in the near future
// const target = process.env.NODE_ENV === 'production' ? 'browserslist' : 'web';

const path = require('path');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const webpack = require('webpack');

module.exports = {
  entry : {
    // helloworld: './src/index.tsx',
    smplayer: './src/app/templates/smplayer/index.tsx',
    home: './src/app/templates/home/index.tsx',
    // create: './src/app/templates/create/index.tsx',
  },
  output: {
    filename: '[name].bundle.js'
  },
  mode: mode,
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: path.resolve(__dirname, 'node_modules'),
        use: {
          loader: 'babel-loader',
        },
      },
      {
        test: /\.(ts|tsx)$/,
        exclude: path.resolve(__dirname, 'node_modules'),
        use: ['babel-loader', 'ts-loader'],
      },
      {  
        test: /\.css$/,
        use: ['style-loader', 
          {
            loader: 'css-loader',
            options: {
              modules: true, // Enable CSS modules
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
    })
  ],
  // target: target,
  target: ['web', 'es5'],
  devtool: 'cheap-module-source-map',
  // devServer: {
  //   static: './dist',
  //   port: 3000,
  // }
};
