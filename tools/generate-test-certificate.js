process.env.GOOGLE_OAUTH_CLIENT_ID = 'fake-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-client-secret';
process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'fake-refresh-token';
process.env.GOOGLE_DRIVE_FOLDER_ID = 'fake-folder-id';
process.env.CERTIFICATE_WEBHOOK_URL = 'http://127.0.0.1:9999/fake-webhook';

global.fetch = async (url) => {
  const target = String(url);

  if (target.includes('oauth2.googleapis.com/token')) {
    return Response.json({ access_token: 'fake-access-token' });
  }

  if (target.includes('www.googleapis.com/upload/drive/v3/files')) {
    return Response.json({
      id: 'fake-drive-file-id',
      webViewLink: 'https://drive.google.com/file/d/fake-drive-file-id/view',
    });
  }

  if (target.includes('www.googleapis.com/drive/v3/files/fake-drive-file-id/permissions')) {
    return Response.json({ id: 'fake-permission-id' });
  }

  if (target.includes('127.0.0.1:9999/fake-webhook')) {
    return Response.json({ ok: true });
  }

  throw new Error(`Unexpected request: ${target}`);
};

const { processCertificates } = require('./certificate');

processCertificates({
  data: [
    {
      student_name: 'Youssef yasser',
      course_name: 'Mblock',
      grade: 'Excellent',
      student_id: 'test-student-id',
    },
  ],
})
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    console.log('\nGenerated PDF: certificates_temp/Youssef_yasser_test-student-id.pdf');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
