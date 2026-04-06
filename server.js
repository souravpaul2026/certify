require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// --- Data directory setup ---
const DATA_DIR = path.join(__dirname, 'data');
const EXAMS_FILE = path.join(DATA_DIR, 'exams.json');
const LINKS_FILE = path.join(DATA_DIR, 'links.json');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(EXAMS_FILE)) fs.writeFileSync(EXAMS_FILE, '[]');
if (!fs.existsSync(LINKS_FILE)) fs.writeFileSync(LINKS_FILE, '[]');
if (!fs.existsSync(SUBMISSIONS_FILE)) fs.writeFileSync(SUBMISSIONS_FILE, '[]');

// --- Helpers ---
const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'));
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// --- Google Sheets setup ---
let sheetsClient = null;
async function initSheets() {
  const { GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = process.env;
  if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) return;
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
    console.log('✅ Google Sheets connected');
  } catch (e) {
    console.warn('⚠️  Google Sheets not configured:', e.message);
  }
}

async function appendToSheet(submission, exam) {
  if (!sheetsClient || !process.env.GOOGLE_SHEET_ID) return;
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    // Ensure headers exist
    const headerRow = [
      'Submission ID', 'Exam', 'Participant Name', 'Participant Email',
      'Submitted At', 'Status', 'Total Points', 'Max Points', 'Score %'
    ];
    exam.questions.forEach((q, i) => {
      headerRow.push(`Q${i + 1}: ${q.text.substring(0, 30)}...`);
      headerRow.push(`Q${i + 1} Points`);
    });

    const row = [
      submission.id,
      exam.title,
      submission.participantName,
      submission.participantEmail,
      submission.submittedAt,
      submission.status,
      submission.totalPoints ?? '',
      submission.maxPoints,
      submission.totalPoints != null
        ? ((submission.totalPoints / submission.maxPoints) * 100).toFixed(1) + '%'
        : 'Pending'
    ];
    submission.answers.forEach(ans => {
      if (ans.type === 'mcq') {
        const q = exam.questions.find(q => q.id === ans.questionId);
        row.push(q ? q.options[ans.selectedOption] : ans.selectedOption);
        row.push(ans.autoPoints);
      } else {
        row.push(ans.text || '');
        row.push(ans.manualPoints ?? 'Pending');
      }
    });

    // Check if sheet has data
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Sheet1!A1:A2',
    });
    if (!res.data.values || res.data.values.length === 0) {
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: 'Sheet1!A1',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [headerRow] },
      });
    }

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });
  } catch (e) {
    console.warn('Sheets sync error:', e.message);
  }
}

async function updateSheetRow(submission, exam) {
  if (!sheetsClient || !process.env.GOOGLE_SHEET_ID) return;
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Sheet1!A:A',
    });
    if (!res.data.values) return;
    const rowIndex = res.data.values.findIndex(r => r[0] === submission.id);
    if (rowIndex === -1) return;
    const rowNum = rowIndex + 1;

    const row = [
      submission.id,
      exam.title,
      submission.participantName,
      submission.participantEmail,
      submission.submittedAt,
      submission.status,
      submission.totalPoints ?? '',
      submission.maxPoints,
      submission.totalPoints != null
        ? ((submission.totalPoints / submission.maxPoints) * 100).toFixed(1) + '%'
        : 'Pending'
    ];
    submission.answers.forEach(ans => {
      if (ans.type === 'mcq') {
        const q = exam.questions.find(q => q.id === ans.questionId);
        row.push(q ? q.options[ans.selectedOption] : ans.selectedOption);
        row.push(ans.autoPoints);
      } else {
        row.push(ans.text || '');
        row.push(ans.manualPoints ?? 'Pending');
      }
    });

    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `Sheet1!A${rowNum}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });
  } catch (e) {
    console.warn('Sheets update error:', e.message);
  }
}

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Admin auth middleware ---
function adminAuth(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ===================== EXAM ROUTES =====================

// Create exam
app.post('/api/exams', adminAuth, (req, res) => {
  const { title, description, timeLimit } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const exam = {
    id: uuidv4(),
    title,
    description: description || '',
    timeLimit: timeLimit || 0,
    questions: [],
    createdAt: new Date().toISOString(),
  };
  const exams = readJSON(EXAMS_FILE);
  exams.push(exam);
  writeJSON(EXAMS_FILE, exams);
  res.json(exam);
});

// Get all exams
app.get('/api/exams', adminAuth, (req, res) => {
  res.json(readJSON(EXAMS_FILE));
});

// Get single exam (admin)
app.get('/api/exams/:id', adminAuth, (req, res) => {
  const exam = readJSON(EXAMS_FILE).find(e => e.id === req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  res.json(exam);
});

// Update exam
app.put('/api/exams/:id', adminAuth, (req, res) => {
  const exams = readJSON(EXAMS_FILE);
  const idx = exams.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Exam not found' });
  const { title, description, timeLimit } = req.body;
  if (title) exams[idx].title = title;
  if (description !== undefined) exams[idx].description = description;
  if (timeLimit !== undefined) exams[idx].timeLimit = timeLimit;
  writeJSON(EXAMS_FILE, exams);
  res.json(exams[idx]);
});

// Delete exam
app.delete('/api/exams/:id', adminAuth, (req, res) => {
  let exams = readJSON(EXAMS_FILE);
  exams = exams.filter(e => e.id !== req.params.id);
  writeJSON(EXAMS_FILE, exams);
  res.json({ success: true });
});

// Add question
app.post('/api/exams/:id/questions', adminAuth, (req, res) => {
  const exams = readJSON(EXAMS_FILE);
  const idx = exams.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Exam not found' });
  const { type, text, options, correctOption, maxPoints } = req.body;
  if (!type || !text) return res.status(400).json({ error: 'type and text are required' });
  if (type === 'mcq' && (!options || options.length < 2 || correctOption === undefined)) {
    return res.status(400).json({ error: 'MCQ needs options and correctOption' });
  }
  const question = {
    id: uuidv4(),
    type,
    text,
    options: type === 'mcq' ? options : undefined,
    correctOption: type === 'mcq' ? correctOption : undefined,
    maxPoints: type === 'mcq' ? 10 : (maxPoints || 10),
    order: exams[idx].questions.length + 1,
  };
  exams[idx].questions.push(question);
  writeJSON(EXAMS_FILE, exams);
  res.json(question);
});

// Update question
app.put('/api/exams/:id/questions/:qid', adminAuth, (req, res) => {
  const exams = readJSON(EXAMS_FILE);
  const exam = exams.find(e => e.id === req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const qIdx = exam.questions.findIndex(q => q.id === req.params.qid);
  if (qIdx === -1) return res.status(404).json({ error: 'Question not found' });
  Object.assign(exam.questions[qIdx], req.body);
  writeJSON(EXAMS_FILE, exams);
  res.json(exam.questions[qIdx]);
});

// Delete question
app.delete('/api/exams/:id/questions/:qid', adminAuth, (req, res) => {
  const exams = readJSON(EXAMS_FILE);
  const exam = exams.find(e => e.id === req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  exam.questions = exam.questions.filter(q => q.id !== req.params.qid);
  writeJSON(EXAMS_FILE, exams);
  res.json({ success: true });
});

// ===================== LINKS ROUTES =====================

// Generate individual link
app.post('/api/links', adminAuth, (req, res) => {
  const { examId, participantName, participantEmail } = req.body;
  if (!examId || !participantName || !participantEmail) {
    return res.status(400).json({ error: 'examId, participantName, participantEmail required' });
  }
  const exams = readJSON(EXAMS_FILE);
  if (!exams.find(e => e.id === examId)) return res.status(404).json({ error: 'Exam not found' });

  const token = uuidv4();
  const link = {
    token,
    examId,
    participantName,
    participantEmail,
    used: false,
    createdAt: new Date().toISOString(),
  };
  const links = readJSON(LINKS_FILE);
  links.push(link);
  writeJSON(LINKS_FILE, links);

  const url = `${req.protocol}://${req.get('host')}/exam/${token}`;
  res.json({ ...link, url });
});

// Bulk generate links
app.post('/api/links/bulk', adminAuth, (req, res) => {
  const { examId, participants } = req.body;
  if (!examId || !participants || !Array.isArray(participants)) {
    return res.status(400).json({ error: 'examId and participants[] required' });
  }
  const exams = readJSON(EXAMS_FILE);
  if (!exams.find(e => e.id === examId)) return res.status(404).json({ error: 'Exam not found' });

  const links = readJSON(LINKS_FILE);
  const newLinks = participants.map(p => {
    const token = uuidv4();
    const link = {
      token,
      examId,
      participantName: p.name,
      participantEmail: p.email,
      used: false,
      createdAt: new Date().toISOString(),
    };
    links.push(link);
    return { ...link, url: `${req.protocol}://${req.get('host')}/exam/${token}` };
  });
  writeJSON(LINKS_FILE, links);
  res.json(newLinks);
});

// Get all links for an exam
app.get('/api/links', adminAuth, (req, res) => {
  const { examId } = req.query;
  let links = readJSON(LINKS_FILE);
  if (examId) links = links.filter(l => l.examId === examId);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json(links.map(l => ({ ...l, url: `${baseUrl}/exam/${l.token}` })));
});

// Delete link
app.delete('/api/links/:token', adminAuth, (req, res) => {
  let links = readJSON(LINKS_FILE);
  links = links.filter(l => l.token !== req.params.token);
  writeJSON(LINKS_FILE, links);
  res.json({ success: true });
});

// ===================== EXAM TAKING =====================

// Get exam by token (participant view — no answers)
app.get('/api/take/:token', (req, res) => {
  const links = readJSON(LINKS_FILE);
  const link = links.find(l => l.token === req.params.token);
  if (!link) return res.status(404).json({ error: 'Invalid or expired link' });

  const submissions = readJSON(SUBMISSIONS_FILE);
  const existing = submissions.find(s => s.token === req.params.token);
  if (existing) return res.status(409).json({ error: 'Exam already submitted', submission: { id: existing.id, status: existing.status } });

  const exams = readJSON(EXAMS_FILE);
  const exam = exams.find(e => e.id === link.examId);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });

  // Strip correct answers
  const safeExam = {
    ...exam,
    questions: exam.questions.map(q => ({
      id: q.id,
      type: q.type,
      text: q.text,
      options: q.options,
      maxPoints: q.maxPoints,
      order: q.order,
    })),
  };

  res.json({ exam: safeExam, participant: { name: link.participantName, email: link.participantEmail } });
});

// Submit exam
app.post('/api/take/:token/submit', async (req, res) => {
  const links = readJSON(LINKS_FILE);
  const link = links.find(l => l.token === req.params.token);
  if (!link) return res.status(404).json({ error: 'Invalid link' });

  const submissions = readJSON(SUBMISSIONS_FILE);
  if (submissions.find(s => s.token === req.params.token)) {
    return res.status(409).json({ error: 'Exam already submitted' });
  }

  const exams = readJSON(EXAMS_FILE);
  const exam = exams.find(e => e.id === link.examId);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });

  const { answers } = req.body;
  if (!answers || !Array.isArray(answers)) return res.status(400).json({ error: 'answers[] required' });

  let hasSubjective = false;
  let autoTotal = 0;
  let maxPoints = 0;

  const gradedAnswers = exam.questions.map(q => {
    const ans = answers.find(a => a.questionId === q.id);
    maxPoints += q.maxPoints;
    if (q.type === 'mcq') {
      const selectedOption = ans ? ans.selectedOption : null;
      const correct = selectedOption === q.correctOption;
      const pts = selectedOption !== null ? (correct ? 10 : 0) : 0;
      autoTotal += pts;
      return {
        questionId: q.id,
        type: 'mcq',
        selectedOption,
        isCorrect: correct,
        autoPoints: pts,
      };
    } else {
      hasSubjective = true;
      return {
        questionId: q.id,
        type: 'subjective',
        text: ans ? ans.text : '',
        manualPoints: null,
        feedback: null,
      };
    }
  });

  const submission = {
    id: uuidv4(),
    token: req.params.token,
    examId: link.examId,
    examTitle: exam.title,
    participantName: link.participantName,
    participantEmail: link.participantEmail,
    answers: gradedAnswers,
    autoPoints: autoTotal,
    totalPoints: hasSubjective ? null : autoTotal,
    maxPoints,
    status: hasSubjective ? 'pending_review' : 'graded',
    submittedAt: new Date().toISOString(),
    gradedAt: hasSubjective ? null : new Date().toISOString(),
  };

  submissions.push(submission);
  writeJSON(SUBMISSIONS_FILE, submissions);

  // Mark link as used
  const linkIdx = links.findIndex(l => l.token === req.params.token);
  links[linkIdx].used = true;
  writeJSON(LINKS_FILE, links);

  // Sync to Google Sheets
  await appendToSheet(submission, exam);

  res.json({
    success: true,
    submissionId: submission.id,
    status: submission.status,
    autoPoints: submission.autoPoints,
    totalPoints: submission.totalPoints,
    maxPoints: submission.maxPoints,
  });
});

// ===================== REVIEW / GRADING =====================

// Get submissions (admin)
app.get('/api/submissions', adminAuth, (req, res) => {
  const { examId, status } = req.query;
  let subs = readJSON(SUBMISSIONS_FILE);
  if (examId) subs = subs.filter(s => s.examId === examId);
  if (status) subs = subs.filter(s => s.status === status);
  res.json(subs);
});

// Get single submission
app.get('/api/submissions/:id', adminAuth, (req, res) => {
  const sub = readJSON(SUBMISSIONS_FILE).find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'Not found' });

  const exams = readJSON(EXAMS_FILE);
  const exam = exams.find(e => e.id === sub.examId);
  res.json({ submission: sub, exam });
});

// Grade submission (set manual points for subjective answers)
app.post('/api/submissions/:id/grade', adminAuth, async (req, res) => {
  const submissions = readJSON(SUBMISSIONS_FILE);
  const idx = submissions.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const { grades } = req.body; // [{ questionId, points, feedback }]
  if (!grades || !Array.isArray(grades)) return res.status(400).json({ error: 'grades[] required' });

  const sub = submissions[idx];
  grades.forEach(g => {
    const ans = sub.answers.find(a => a.questionId === g.questionId);
    if (ans && ans.type === 'subjective') {
      ans.manualPoints = g.points;
      ans.feedback = g.feedback || null;
    }
  });

  // Recalculate total
  const allGraded = sub.answers.every(a =>
    a.type === 'mcq' || (a.type === 'subjective' && a.manualPoints !== null)
  );

  if (allGraded) {
    sub.totalPoints = sub.answers.reduce((sum, a) => {
      return sum + (a.type === 'mcq' ? a.autoPoints : (a.manualPoints || 0));
    }, 0);
    sub.status = 'graded';
    sub.gradedAt = new Date().toISOString();
  }

  writeJSON(SUBMISSIONS_FILE, submissions);

  const exams = readJSON(EXAMS_FILE);
  const exam = exams.find(e => e.id === sub.examId);
  await updateSheetRow(sub, exam);

  res.json(sub);
});

// ===================== RESULT PAGE =====================

// Public result page for participant
app.get('/api/result/:submissionId', (req, res) => {
  const sub = readJSON(SUBMISSIONS_FILE).find(s => s.id === req.params.submissionId);
  if (!sub) return res.status(404).json({ error: 'Not found' });

  const exams = readJSON(EXAMS_FILE);
  const exam = exams.find(e => e.id === sub.examId);

  // Return safe result (no correct answers for ungraded)
  res.json({ submission: sub, exam });
});

// ===================== EXPORT =====================

app.get('/api/export/:examId', adminAuth, (req, res) => {
  const exams = readJSON(EXAMS_FILE);
  const exam = exams.find(e => e.id === req.params.examId);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });

  const submissions = readJSON(SUBMISSIONS_FILE).filter(s => s.examId === req.params.examId);

  const headers = [
    'Name', 'Email', 'Submitted At', 'Status', 'Total Points', 'Max Points', 'Score %',
    ...exam.questions.map((q, i) => `Q${i + 1}: ${q.text.substring(0, 40)}`),
    ...exam.questions.map((q, i) => `Q${i + 1} Points`),
  ];

  const rows = submissions.map(s => {
    const answerTexts = exam.questions.map(q => {
      const ans = s.answers.find(a => a.questionId === q.id);
      if (!ans) return '';
      if (q.type === 'mcq') return q.options[ans.selectedOption] ?? '';
      return ans.text || '';
    });
    const answerPoints = exam.questions.map(q => {
      const ans = s.answers.find(a => a.questionId === q.id);
      if (!ans) return '';
      if (q.type === 'mcq') return ans.autoPoints;
      return ans.manualPoints ?? 'Pending';
    });

    return [
      s.participantName,
      s.participantEmail,
      s.submittedAt,
      s.status,
      s.totalPoints ?? 'Pending',
      s.maxPoints,
      s.totalPoints != null ? ((s.totalPoints / s.maxPoints) * 100).toFixed(1) + '%' : 'Pending',
      ...answerTexts,
      ...answerPoints,
    ];
  });

  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${exam.title.replace(/[^a-z0-9]/gi, '_')}_results.csv"`);
  res.send(csv);
});

// ===================== STATIC ROUTES =====================

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/exam/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'exam.html')));
app.get('/review', (req, res) => res.sendFile(path.join(__dirname, 'public', 'review.html')));
app.get('/result/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'result.html')));

// ===================== START =====================

initSheets().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🎓 Certification Platform running at http://localhost:${PORT}`);
    console.log(`   Admin password: ${ADMIN_PASSWORD}`);
    console.log(`   Admin panel:    http://localhost:${PORT}/`);
    console.log(`   Review page:    http://localhost:${PORT}/review\n`);
  });
});
