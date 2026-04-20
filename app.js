const express = require('express');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const dotenv = require('dotenv');
dotenv.config({ path: './.env' });

const mongoSanitize = require('express-mongo-sanitize');
const xssClean = require('xss-clean');
const hpp = require('hpp');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { processCertificates } = require('./tools/certificate');
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
app.use(helmet());
app.use(helmet.crossOriginResourcePolicy({ policy: 'cross-origin' }));
app.use(mongoSanitize());
app.use(xssClean());
app.use(hpp());
app.use(compression());
app.use(cors({
  origin: process.env.FRONT_URL,
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  credentials: true,
}));
app.use(rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.RATE_LIMIT_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false,
}));
app.use(morgan('tiny'));
app.use((req, res, next) => {
  res.locals.messages = require('express-messages')(req, res);
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

function requireCertificateApiKey(req, res, next) {
  const apiKey = process.env.CERTIFICATE_API_KEY;
  if (!apiKey) {
    return next();
  }

  const authorization = req.get('authorization') || '';
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
  const requestApiKey = bearerToken || req.get('x-api-key');

  if (requestApiKey !== apiKey) {
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized certificate generation request.',
    });
  }

  return next();
}

app.post('/api/certificates/generate', requireCertificateApiKey, async (req, res) => {
  try {
    const result = await processCertificates(req.body);
    const hasFailures = result.failed > 0;
    res.status(hasFailures ? 207 : 200).json({
      status: hasFailures ? 'partial_success' : 'success',
      message: hasFailures
        ? 'Certificates processed with some failures.'
        : 'Certificates generated and synced successfully.',
      result,
    });
  } catch (error) {
    const statusCode = error.statusCode || 400;
    res.status(statusCode).json({
      status: 'error',
      message: error.message || 'Failed to process certificates.',
    });
  }
});

app.use((error, req, res, next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      status: 'error',
      message: 'Payload too large. Reduce request body size and try again.',
    });
  }
  return next(error);
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }
  console.error(error);
  return res.status(500).json({
    status: 'error',
    message: 'Internal server error.',
  });
});

module.exports = app;
