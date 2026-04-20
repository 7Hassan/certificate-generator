const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PDFDocument } = require('pdf-lib');

const { processCertificates } = require('../tools/certificate');
const fakePayload = require('./fixtures/certificate-payload.json');

async function createTemplate(templatePath) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([842, 595]);
  await fs.promises.writeFile(templatePath, await pdfDoc.save());
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createFakeGoogleAndWebhookServer() {
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });

    if (req.method === 'POST' && req.url === '/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'fake-access-token' }));
      return;
    }

    if (req.method === 'POST' && req.url.startsWith('/upload/drive/v3/files')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: `fake-file-${requests.filter((item) => item.url.startsWith('/upload/drive/v3/files')).length}`,
        webViewLink: 'https://drive.google.com/file/d/fake-file/view',
      }));
      return;
    }

    if (req.method === 'POST' && /^\/drive\/v3\/files\/fake-file-\d+\/permissions(?:\?.*)?$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'fake-permission' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/webhook/digital-certificate') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unexpected fake endpoint' }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((closeResolve) => server.close(closeResolve)),
        requests,
      });
    });
  });
}

test('processCertificates generates PDFs, uploads to Drive, makes them public, and notifies webhook', async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'schoola-certificates-'));
  const certificatesDir = path.join(tempRoot, 'generated');
  const projectTemplatePath = path.join(__dirname, '..', 'certificates_temp', 'certificate.pdf');
  const templatePath = fs.existsSync(projectTemplatePath) ? projectTemplatePath : path.join(tempRoot, 'template.pdf');
  await fs.promises.mkdir(certificatesDir);
  if (templatePath !== projectTemplatePath) {
    await createTemplate(templatePath);
  }

  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fakeServer = await createFakeGoogleAndWebhookServer();
  t.after(async () => {
    await fakeServer.close();
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  process.env.CERTIFICATES_DIR = certificatesDir;
  process.env.CERTIFICATE_TEMPLATE_PATH = templatePath;
  process.env.GOOGLE_CLIENT_EMAIL = 'service-account@example.test';
  process.env.GOOGLE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.GOOGLE_DRIVE_FOLDER_ID = 'fake-folder-id';
  process.env.GOOGLE_TOKEN_URL = `${fakeServer.baseUrl}/token`;
  process.env.GOOGLE_UPLOAD_URL = `${fakeServer.baseUrl}/upload/drive/v3/files`;
  process.env.GOOGLE_DRIVE_API_URL = `${fakeServer.baseUrl}/drive/v3`;
  process.env.CERTIFICATE_WEBHOOK_URL = `${fakeServer.baseUrl}/webhook/digital-certificate`;

  const result = await processCertificates(fakePayload);

  assert.equal(result.total, fakePayload.data.length);
  assert.equal(result.succeeded, fakePayload.data.length);
  assert.equal(result.failed, 0);
  assert.ok(result.results.every((item) => item.status === 'success'));

  const generatedFiles = await fs.promises.readdir(certificatesDir);
  assert.equal(generatedFiles.length, fakePayload.data.length);
  assert.ok(generatedFiles.every((file) => file.endsWith('.pdf')));

  const tokenRequests = fakeServer.requests.filter((item) => item.url === '/token');
  const uploadRequests = fakeServer.requests.filter((item) => item.url.startsWith('/upload/drive/v3/files'));
  const permissionRequests = fakeServer.requests.filter((item) => /\/permissions(?:\?.*)?$/.test(item.url));
  const webhookRequests = fakeServer.requests.filter((item) => item.url === '/webhook/digital-certificate');
  const firstWebhookIndex = fakeServer.requests.findIndex((item) => item.url === '/webhook/digital-certificate');
  const lastUploadIndex = fakeServer.requests.findLastIndex((item) => item.url.startsWith('/upload/drive/v3/files'));

  assert.equal(tokenRequests.length, 1);
  assert.equal(uploadRequests.length, fakePayload.data.length);
  assert.equal(permissionRequests.length, fakePayload.data.length);
  assert.equal(webhookRequests.length, fakePayload.data.length);
  assert.ok(lastUploadIndex < firstWebhookIndex);

  assert.match(uploadRequests[0].headers.authorization, /^Bearer fake-access-token$/);
  assert.match(uploadRequests[0].headers['content-type'], /^multipart\/related; boundary=/);
  assert.match(uploadRequests[0].body.toString('latin1'), /"parents":\["fake-folder-id"\]/);
  assert.match(uploadRequests[0].body.toString('latin1'), /Content-Type: application\/pdf/);

  assert.deepEqual(JSON.parse(permissionRequests[0].body.toString('utf8')), {
    role: 'reader',
    type: 'anyone',
  });
  assert.deepEqual(JSON.parse(webhookRequests[0].body.toString('utf8')), {
    id: fakePayload.data[0].student_id,
    certificateLink: 'https://drive.google.com/file/d/fake-file/view',
  });
});
