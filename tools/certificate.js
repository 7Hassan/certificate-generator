const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('fontkit');

const DEFAULT_FONT_PATH = path.join(__dirname, '..', 'fonts', 'SomarRounded-SemiBold.ttf');
const DEFAULT_CERTIFICATES_DIR = path.join(__dirname, '..', 'certificates_temp');
const DEFAULT_TEMPLATE_PATH = path.join(DEFAULT_CERTIFICATES_DIR, 'certificate.pdf');
const DEFAULT_WEBHOOK_URL = 'https://n8n.schoola.academy/webhook/digital-certificate';
const DEFAULT_DRIVE_FOLDER_ID = '1YMlfu5cGGoLGDQ7ghKOKMC_g2UI-uWPY';
const DEFAULT_GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_GOOGLE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const DEFAULT_GOOGLE_DRIVE_API_URL = 'https://www.googleapis.com/drive/v3';
const DEFAULT_HTTP_TIMEOUT_MS = 15000;
const MAX_FIELD_LENGTH = 150;

class RequestValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestValidationError';
    this.statusCode = 400;
  }
}

function getConfig() {
  return {
    fontPath: process.env.CERTIFICATE_FONT_PATH || DEFAULT_FONT_PATH,
    certificatesDir: process.env.CERTIFICATES_DIR || DEFAULT_CERTIFICATES_DIR,
    templatePath: process.env.CERTIFICATE_TEMPLATE_PATH || DEFAULT_TEMPLATE_PATH,
    webhookUrl: process.env.CERTIFICATE_WEBHOOK_URL || DEFAULT_WEBHOOK_URL,
    driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || DEFAULT_DRIVE_FOLDER_ID,
    googleTokenUrl: process.env.GOOGLE_TOKEN_URL || DEFAULT_GOOGLE_TOKEN_URL,
    googleUploadUrl: process.env.GOOGLE_UPLOAD_URL || DEFAULT_GOOGLE_UPLOAD_URL,
    googleDriveApiUrl: process.env.GOOGLE_DRIVE_API_URL || DEFAULT_GOOGLE_DRIVE_API_URL,
    googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    googleOAuthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    googleOAuthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  };
}

function assertValidRequestPayload(payload) {
  if (!payload || !Array.isArray(payload.data) || payload.data.length === 0) {
    throw new RequestValidationError('Request body must include a non-empty data array.');
  }

  if (payload.data.length > 1000) {
    throw new RequestValidationError('Request is too large. Maximum 1000 students per request.');
  }

  payload.data.forEach((student, index) => {
    if (!student || typeof student !== 'object') {
      throw new RequestValidationError(`data[${index}] must be an object.`);
    }
    if (!student.student_name || typeof student.student_name !== 'string' || !student.student_name.trim() || student.student_name.trim().length > MAX_FIELD_LENGTH) {
      throw new RequestValidationError(`data[${index}].student_name is required and must be at most ${MAX_FIELD_LENGTH} chars.`);
    }
    if (!student.course_name || typeof student.course_name !== 'string' || !student.course_name.trim() || student.course_name.trim().length > MAX_FIELD_LENGTH) {
      throw new RequestValidationError(`data[${index}].course_name is required and must be at most ${MAX_FIELD_LENGTH} chars.`);
    }
    if (!student.grade || typeof student.grade !== 'string' || !student.grade.trim() || student.grade.trim().length > MAX_FIELD_LENGTH) {
      throw new RequestValidationError(`data[${index}].grade is required and must be at most ${MAX_FIELD_LENGTH} chars.`);
    }
    if (!student.student_id || typeof student.student_id !== 'string' || !student.student_id.trim() || student.student_id.trim().length > MAX_FIELD_LENGTH) {
      throw new RequestValidationError(`data[${index}].student_id is required and must be at most ${MAX_FIELD_LENGTH} chars.`);
    }
  });
}

async function clearCertificatesDirectory(config) {
  await fs.promises.mkdir(config.certificatesDir, { recursive: true });
  const entries = await fs.promises.readdir(config.certificatesDir);
  const templatePath = path.resolve(config.templatePath);

  await Promise.all(
    entries
      .map((entry) => path.join(config.certificatesDir, entry))
      .filter((entryPath) => path.resolve(entryPath) !== templatePath)
      .map((entryPath) => fs.promises.rm(entryPath, { recursive: true, force: true })),
  );
}

function drawCenteredText(page, text, font, fontSize, y, color) {
  const safeText = String(text).trim();
  const textWidth = font.widthOfTextAtSize(safeText, fontSize);
  page.drawText(safeText, {
    x: (page.getWidth() - textWidth) / 2,
    y,
    size: fontSize,
    font,
    color,
  });
}

async function generateCertificatePdf(templateBytes, student, fontBytes) {
  const pdfDoc = await PDFDocument.load(templateBytes);
  pdfDoc.registerFontkit(fontkit);
  const somarFont = await pdfDoc.embedFont(fontBytes);
  const [firstPage] = pdfDoc.getPages();

  drawCenteredText(firstPage, student.student_name, somarFont, 43, 215, rgb(1, 0.498, 0.106));
  drawCenteredText(firstPage, student.course_name, somarFont, 38, 440, rgb(1, 0.498, 0.11));

  const footerText = student.level;
  drawCenteredText(firstPage, footerText, somarFont, 15, 135, rgb(0.02, 0.44, 0.93));
  const degree = `${student.grade} Degree`;
  drawCenteredText(firstPage, degree, somarFont, 20, 105, rgb(1, 0.498, 0.106));

  const issueDate = new Date().toLocaleDateString('en-GB');
  const dateText = `Issue Date: ${issueDate}`;

  firstPage.drawText(dateText, {
    x: 590,
    y: 15,
    size: 10,
    font: somarFont,
    color: rgb(0.0196, 0.4353, 0.9255),
  });

  return pdfDoc.save();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getGoogleCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    let parsed;
    try {
      parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (error) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.');
    }
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
    };
  }

  return {
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY,
  };
}

async function getGoogleAccessToken(config) {
  const timeoutMs = Number(process.env.CERTIFICATE_HTTP_TIMEOUT_MS || DEFAULT_HTTP_TIMEOUT_MS);
  if (config.googleOAuthClientId && config.googleOAuthClientSecret && config.googleOAuthRefreshToken) {
    const tokenResponse = await fetchWithTimeout(config.googleTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.googleOAuthClientId,
        client_secret: config.googleOAuthClientSecret,
        refresh_token: config.googleOAuthRefreshToken,
        grant_type: 'refresh_token',
      }),
    }, timeoutMs);

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      throw new Error(`Failed to refresh Google OAuth token: ${errorBody}`);
    }

    const tokenData = await tokenResponse.json();
    return tokenData.access_token;
  }

  const credentials = getGoogleCredentials();
  const clientEmail = credentials.clientEmail;
  const privateKey = credentials.privateKey ? credentials.privateKey.replace(/\\n/g, '\n') : null;

  if (!clientEmail || !privateKey) {
    throw new Error('Google credentials are missing. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY.');
  }

  const currentTime = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: 'https://oauth2.googleapis.com/token',
      iat: currentTime,
      exp: currentTime + 3600,
    },
    privateKey,
    { algorithm: 'RS256' },
  );

  const tokenResponse = await fetchWithTimeout(config.googleTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  }, timeoutMs);

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    throw new Error(`Failed to get Google access token: ${errorBody}`);
  }

  const tokenData = await tokenResponse.json();
  return tokenData.access_token;
}

async function uploadToDrive(localFilePath, fileName, accessToken, config) {
  const timeoutMs = Number(process.env.CERTIFICATE_HTTP_TIMEOUT_MS || DEFAULT_HTTP_TIMEOUT_MS);
  const fileBuffer = await fs.promises.readFile(localFilePath);
  const boundary = `certificate-boundary-${Date.now()}`;
  const metadata = { name: fileName, parents: [config.driveFolderId] };

  const multipartBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const uploadUrl = new URL(config.googleUploadUrl);
  uploadUrl.searchParams.set('uploadType', 'multipart');
  uploadUrl.searchParams.set('fields', 'id,webViewLink');
  uploadUrl.searchParams.set('supportsAllDrives', 'true');

  const uploadResponse = await fetchWithTimeout(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  }, timeoutMs);

  if (!uploadResponse.ok) {
    const errorBody = await uploadResponse.text();
    throw new Error(`Drive upload failed: ${errorBody}`);
  }

  const uploadedFile = await uploadResponse.json();
  const permissionUrl = new URL(`${config.googleDriveApiUrl}/files/${uploadedFile.id}/permissions`);
  permissionUrl.searchParams.set('supportsAllDrives', 'true');

  const permissionResponse = await fetchWithTimeout(permissionUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  }, timeoutMs);

  if (!permissionResponse.ok) {
    const errorBody = await permissionResponse.text();
    throw new Error(`Failed to make file public: ${errorBody}`);
  }

  return uploadedFile.webViewLink || `https://drive.google.com/file/d/${uploadedFile.id}/view`;
}

async function notifyWebhook(studentId, certificateLink, config) {
  const timeoutMs = Number(process.env.CERTIFICATE_HTTP_TIMEOUT_MS || DEFAULT_HTTP_TIMEOUT_MS);
  const webhookResponse = await fetchWithTimeout(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: studentId,
      certificateLink,
    }),
  }, timeoutMs);

  if (!webhookResponse.ok) {
    const errorBody = await webhookResponse.text();
    throw new Error(`Webhook notification failed: ${errorBody}`);
  }
}

async function processCertificates(payload) {
  assertValidRequestPayload(payload);
  const config = getConfig();
  await fs.promises.access(config.templatePath, fs.constants.R_OK);
  await fs.promises.access(config.fontPath, fs.constants.R_OK);
  await clearCertificatesDirectory(config);

  const templateBytes = await fs.promises.readFile(config.templatePath);
  const fontBytes = await fs.promises.readFile(config.fontPath);
  const accessToken = await getGoogleAccessToken(config);
  const results = [];

  for (const studentRow of payload.data) {
    let localCertificatePath = null;
    const student = {
      student_name: studentRow.student_name.trim(),
      course_name: studentRow.course_name.trim(),
      grade: studentRow.grade.trim(),
      level: typeof studentRow.level === 'string' ? studentRow.level.trim() : '',
      student_id: studentRow.student_id.trim(),
    };

    try {
      const safeStudentName = student.student_name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
      const driveFileName = `${safeStudentName || 'student'}_${student.student_id}.pdf`;
      localCertificatePath = path.join(config.certificatesDir, driveFileName);
      const generatedPdf = await generateCertificatePdf(templateBytes, student, fontBytes);
      await fs.promises.writeFile(localCertificatePath, generatedPdf);

      const certificateLink = await uploadToDrive(localCertificatePath, driveFileName, accessToken, config);

      results.push({
        student_id: student.student_id,
        certificate_link: certificateLink,
        status: 'success',
      });
    } catch (error) {
      results.push({
        student_id: student.student_id,
        status: 'failed',
        error: error.message,
      });
    } finally {
      if (localCertificatePath) {
        await fs.promises.rm(localCertificatePath, { force: true });
      }
    }
  }

  for (const result of results.filter((item) => item.status === 'success')) {
    try {
      await notifyWebhook(result.student_id, result.certificate_link, config);
    } catch (error) {
      result.status = 'failed';
      result.error = error.message;
    }
  }

  return {
    total: payload.data.length,
    succeeded: results.filter((item) => item.status === 'success').length,
    failed: results.filter((item) => item.status === 'failed').length,
    results,
  };
}

module.exports = { processCertificates };
