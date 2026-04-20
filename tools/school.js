const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const schools = [
  {
    id: 1,
    name: "Future Vision School",
    email: "egoker1234@gmail.com"
  },
];

const trainingProgramName = "Schoola Coding & AI Program";
const proposalFilePath = path.join(__dirname, '..', 'proposals', 'schoola_proposal.pdf');

// إرسال بريد إلى مدرسة واحدة
async function sendSchoolMail(toEmail, schoolName, filePath, programName) {
  try {
    const emailTemplatePath = path.join(__dirname, '..', 'emails', 'proposal.html');
    let emailHtml = fs.readFileSync(emailTemplatePath, 'utf-8');

    // استبدال المتغيرات داخل HTML
    emailHtml = emailHtml.replace(/{{name}}/g, schoolName)
      .replace(/{{trainingProgramName}}/g, programName);

    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT, 10),
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: `"Schoola Team" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: `🤝 Proposal for ${schoolName} - Empower Students with Coding & AI`,
      text: `Dear ${schoolName},\n\nWe are excited to share with you our latest program: ${programName}. We believe your students will greatly benefit from this initiative.\n\nPlease find attached the detailed proposal.\n\nLooking forward to hearing from you.\n\nBest regards,\nSchoola Team`,
      html: emailHtml,
      attachments: [
        {
          filename: 'Schoola_Proposal.pdf',
          path: filePath,
          contentType: 'application/pdf',
        },
      ],
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`📧 Proposal sent to ${toEmail}: ${info.messageId}`);
  } catch (err) {
    console.error("❌ Failed to send email to", toEmail, ":", err.message);
    throw err;
  }
}

// تنفيذ إرسال البروبوزال لجميع المدارس
async function processSchoolProposals() {
  const results = [];

  for (const school of schools) {
    try {
      await sendSchoolMail(school.email, school.name, proposalFilePath, trainingProgramName);
      results.push({ ...school, status: '✅ sent' });
    } catch (error) {
      results.push({ ...school, status: '❌ failed', error: error.message });
    }
  }

  console.log('📋 Email Sending Results:', results);
}

module.exports = { processSchoolProposals };
