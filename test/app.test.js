const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

function postJson(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/certificates/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
      });
    });

    req.on('error', reject);
    req.end(payload);
  });
}

test('certificate endpoint rejects requests without the configured API key', async (t) => {
  const originalApiKey = process.env.CERTIFICATE_API_KEY;
  process.env.CERTIFICATE_API_KEY = 'test-secret';

  delete require.cache[require.resolve('../app')];
  const app = require('../app');
  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (originalApiKey === undefined) {
      delete process.env.CERTIFICATE_API_KEY;
    } else {
      process.env.CERTIFICATE_API_KEY = originalApiKey;
    }
    delete require.cache[require.resolve('../app')];
  });

  const port = server.address().port;
  const response = await postJson(port, { data: [] });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.status, 'error');
});
