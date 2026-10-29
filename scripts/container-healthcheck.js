// Liveness only; no database opening or lock acquisition.
const http = require('node:http');
const request = http.get({ hostname: '127.0.0.1', port: process.env.PORT, path: '/health', timeout: 3000 }, response => {
  response.resume();
  process.exitCode = response.statusCode === 200 ? 0 : 1;
});
request.on('timeout', () => request.destroy(new Error('Health check timeout')));
request.on('error', () => { process.exitCode = 1; });
