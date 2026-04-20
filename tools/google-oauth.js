const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8020/oauth2callback';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

function getOAuthConfig() {
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || DEFAULT_REDIRECT_URI,
  };
}

function assertOAuthConfig(config) {
  if (!config.clientId || !config.clientSecret) {
    throw new Error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env first.');
  }
}

function getAuthUrl() {
  const config = getOAuthConfig();
  assertOAuthConfig(config);

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', config.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', DRIVE_SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  return authUrl.toString();
}

async function exchangeCode(code) {
  const config = getOAuthConfig();
  assertOAuthConfig(config);

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OAuth code exchange failed: ${body}`);
  }

  const tokenData = JSON.parse(body);
  if (!tokenData.refresh_token) {
    throw new Error('Google did not return a refresh_token. Revoke the app access or use prompt=consent, then try again.');
  }

  return tokenData.refresh_token;
}

function upsertEnvValue(key, value) {
  const envPath = path.join(__dirname, '..', '.env');
  const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = env.split(/\r?\n/).filter((line) => line && !line.startsWith(`${key}=`));
  lines.push(`${key}=${value}`);
  fs.writeFileSync(envPath, `${lines.join('\n')}\n`);
}

async function main() {
  const command = process.argv[2];

  if (command === 'auth-url') {
    console.log(getAuthUrl());
    return;
  }

  if (command === 'exchange') {
    const code = process.argv[3];
    if (!code) {
      throw new Error('Usage: node tools/google-oauth.js exchange <authorization-code>');
    }

    const refreshToken = await exchangeCode(code);
    upsertEnvValue('GOOGLE_OAUTH_REFRESH_TOKEN', refreshToken);
    console.log('GOOGLE_OAUTH_REFRESH_TOKEN saved to .env');
    return;
  }

  console.log('Usage:');
  console.log('  node tools/google-oauth.js auth-url');
  console.log('  node tools/google-oauth.js exchange <authorization-code>');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
