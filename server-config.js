// server-config.js
// TODO WIP - this file is not used yet
const SERVER_CONFIG = {
  production: {
    url: JSON.stringify('localhost'),
    port: 3000, // Specify the port for your Node.js server
  },
  development: {
    url: JSON.stringify('localhost'),
    port: 3000, // Specify the development port
  },
};

module.exports = SERVER_CONFIG;