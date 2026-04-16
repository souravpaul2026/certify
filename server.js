require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cors = require('cors');
const mongoose = require('mongoose');

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// --- MongoDB Connection ---
const rawUri = process.env.MONGODB_URI || '';
const mongoUri = rawUri.trim().replace(/^["'`]+|["'`]+$/g, '') || 'mongodb://localhost:27017/certify';
console.log('Connecting to MongoDB, URI starts with:', mongoUri.substring(0, 20));
mongoose.connect(mongoUri)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

// --- Schemas ---
const questionSchema = new mongoose.Schema({
  id: String,
  type: String,
  text: String,
  options: [String],
  correctOption: Number,
  maxPoints: Number,
  order: Number,
});

const examSchema = new mongoose.Schema({
  id: { type: String, default: () => uuidv4() },
  title: String,
  description: String,
  timeLimit: { type: Number, default: 0 },
  questions: [questionSchema],
  createdAt: { type: Date, default: Date.now },
});

const linkSchema = new mongoose.Schema({
  token: { type: String, default: () => uuidv4() },
  examId: String,
  participantName: String,
  participantEmail: String,
  used: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const answerSchema = new mongoose.Schema({
  questionId: String,
  type: String,
  selectedOption: Number,
  isCorrect: Boolean,
  autoPoints: Number,
  text: String,
  manualPoints: Number,
  feedback: String,
});

const submissionSchema = new mongoose.Schema({
  id: { type: String, default: () => uuidv4() },
  token: String,
  examId: String,
  examTitle: String,
  participantName: String,
  participantEmail: String,
  googleName: String,
  googleEmail: String,
  answers: [answerSchema],
  autoPoints: { type: Number, default: 0 },
  totalPoints: Number,
  maxPoints: Number,
  status: { type: String, default: 'pending_review' },
  submittedAt: { type: Date, default: Date.now },
  gradedAt: Date,
});

const sessionSchema = new mongoose.Schema({
  id: { type: String, default: () => uuidv4() },
  title: String,
  description: String,
  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

const resourceSchema = new mongoose.Schema({
  id: { type: String, default: () => uuidv4() },
  sessionId: String,
  title: String,
  description: String,
  type: { type: String, enum: ['deck', 'recording', 'other'], default: 'other' },
  url: String,
  fileName: String,
  fileData: Buffer,
  fileMimeType: String,
  fileSize: Number,
  createdAt: { type: Date, default: Date.now },
});

const Exam = mongoose.model('Exam', examSchema);
const Link = mongoose.model('Link', linkSchema);
const Submission = mongoose.model('Submission', submissionSchema);
const Session = mongoose.model('Session', sessionSchema);
const Resource = mongoose.model('Resource', resourceSchema);

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
    const headerRow = ['Submission ID', 'Exam', 'Participant Name', 'Participant Email', 'Submitted At', 'Status', 'Total Points', 'Max Points', 'Score %'];
    exam.questions.forEach((q, i) => { headerRow.push(`Q${i+1}: ${q.text.substring(0,30)}`); headerRow.push(`Q${i+1} Points`); });
    const row = [submission.id, exam.title, submission.participantName, submission.participantEmail, submission.submittedAt, submission.status, submission.totalPoints ?? '', submission.maxPoints, submission.totalPoints != null ? ((submission.totalPoints/submission.maxPoints)*100).toFixed(1)+'%' : 'Pending'];
    submission.answers.forEach(ans => {
      if (ans.type === 'mcq') { const q = exam.questions.find(q => q.id === ans.questionId); row.push(q ? q.options[ans.selectedOption] : ans.selectedOption); row.push(ans.autoPoints); }
      else { row.push(ans.text || ''); row.push(ans.manualPoints ?? 'Pending'); }
    });
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Sheet1!A1:A2' });
    if (!res.data.values || res.data.values.length === 0) await sheetsClient.spreadsheets.values.append({ spreadsheetId: sheetId, range: 'Sheet1!A1', valueInputOption: 'USER_ENTERED', resource: { values: [headerRow] } });
    await sheetsClient.spreadsheets.values.append({ spreadsheetId: sheetId, range: 'Sheet1!A1', valueInputOption: 'USER_ENTERED', resource: { values: [row] } });
  } catch (e) { console.warn('Sheets sync error:', e.message); }
}

async function updateSheetRow(submission, exam) {
  if (!sheetsClient || !process.env.GOOGLE_SHEET_ID) return;
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Sheet1!A:A' });
    if (!res.data.values) return;
    const rowIndex = res.data.values.findIndex(r => r[0] === submission.id);
    if (rowIndex === -1) return;
    const row = [submission.id, exam.title, submission.participantName, submission.participantEmail, submission.submittedAt, submission.status, submission.totalPoints ?? '', submission.maxPoints, submission.totalPoints != null ? ((submission.totalPoints/submission.maxPoints)*100).toFixed(1)+'%' : 'Pending'];
    submission.answers.forEach(ans => {
      if (ans.type === 'mcq') { const q = exam.questions.find(q => q.id === ans.questionId); row.push(q ? q.options[ans.selectedOption] : ans.selectedOption); row.push(ans.autoPoints); }
      else { row.push(ans.text || ''); row.push(ans.manualPoints ?? 'Pending'); }
    });
    await sheetsClient.spreadsheets.values.update({ spreadsheetId: sheetId, range: `Sheet1!A${rowIndex+1}`, valueInputOption: 'USER_ENTERED', resource: { values: [row] } });
  } catch (e) { console.warn('Sheets update error:', e.message); }
}

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function adminAuth(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ===================== EXAM ROUTES =====================

app.post('/api/exams', adminAuth, async (req, res) => {
  const { title, description, timeLimit } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const exam = await Exam.create({ id: uuidv4(), title, description: description || '', timeLimit: timeLimit || 0 });
  res.json(exam);
});

app.get('/api/exams', adminAuth, async (req, res) => {
  const exams = await Exam.find().sort({ createdAt: -1 });
  res.json(exams);
});

app.get('/api/exams/:id', adminAuth, async (req, res) => {
  const exam = await Exam.findOne({ id: req.params.id });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  res.json(exam);
});

app.put('/api/exams/:id', adminAuth, async (req, res) => {
  const exam = await Exam.findOneAndUpdate({ id: req.params.id }, req.body, { new: true });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  res.json(exam);
});

app.delete('/api/exams/:id', adminAuth, async (req, res) => {
  await Exam.deleteOne({ id: req.params.id });
  res.json({ success: true });
});

app.post('/api/exams/:id/questions', adminAuth, async (req, res) => {
  const exam = await Exam.findOne({ id: req.params.id });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const { type, text, options, correctOption, maxPoints } = req.body;
  if (!type || !text) return res.status(400).json({ error: 'type and text are required' });
  const question = { id: uuidv4(), type, text, options: type === 'mcq' ? options : undefined, correctOption: type === 'mcq' ? correctOption : undefined, maxPoints: type === 'mcq' ? 10 : (maxPoints || 10), order: exam.questions.length + 1 };
  exam.questions.push(question);
  await exam.save();
  res.json(question);
});

app.put('/api/exams/:id/questions/:qid', adminAuth, async (req, res) => {
  const exam = await Exam.findOne({ id: req.params.id });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const qIdx = exam.questions.findIndex(q => q.id === req.params.qid);
  if (qIdx === -1) return res.status(404).json({ error: 'Question not found' });
  Object.assign(exam.questions[qIdx], req.body);
  await exam.save();
  res.json(exam.questions[qIdx]);
});

app.delete('/api/exams/:id/questions/:qid', adminAuth, async (req, res) => {
  const exam = await Exam.findOne({ id: req.params.id });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  exam.questions = exam.questions.filter(q => q.id !== req.params.qid);
  await exam.save();
  res.json({ success: true });
});

// ===================== LINKS =====================

app.post('/api/links', adminAuth, async (req, res) => {
  const { examId, participantName, participantEmail } = req.body;
  if (!examId || !participantName || !participantEmail) return res.status(400).json({ error: 'examId, participantName, participantEmail required' });
  const exam = await Exam.findOne({ id: examId });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const link = await Link.create({ token: uuidv4(), examId, participantName, participantEmail });
  const url = `${req.protocol}://${req.get('host')}/exam/${link.token}`;
  res.json({ ...link.toObject(), url });
});

app.post('/api/links/bulk', adminAuth, async (req, res) => {
  const { examId, participants } = req.body;
  if (!examId || !participants) return res.status(400).json({ error: 'examId and participants[] required' });
  const exam = await Exam.findOne({ id: examId });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const links = await Link.insertMany(participants.map(p => ({ token: uuidv4(), examId, participantName: p.name, participantEmail: p.email })));
  const base = `${req.protocol}://${req.get('host')}`;
  res.json(links.map(l => ({ ...l.toObject(), url: `${base}/exam/${l.token}` })));
});

app.get('/api/links', adminAuth, async (req, res) => {
  const { examId } = req.query;
  const filter = examId ? { examId } : {};
  const links = await Link.find(filter).sort({ createdAt: -1 });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json(links.map(l => ({ ...l.toObject(), url: `${base}/exam/${l.token}` })));
});

app.delete('/api/links/:token', adminAuth, async (req, res) => {
  await Link.deleteOne({ token: req.params.token });
  res.json({ success: true });
});

// ===================== EXAM TAKING =====================

app.get('/api/take/:token', async (req, res) => {
  const link = await Link.findOne({ token: req.params.token });
  if (!link) return res.status(404).json({ error: 'Invalid or expired link' });
  const existing = await Submission.findOne({ token: req.params.token });
  if (existing) return res.status(409).json({ error: 'Exam already submitted', submission: { id: existing.id, status: existing.status } });
  const exam = await Exam.findOne({ id: link.examId });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const safeExam = { ...exam.toObject(), questions: exam.questions.map(q => ({ id: q.id, type: q.type, text: q.text, options: q.options, maxPoints: q.maxPoints, order: q.order })) };
  res.json({ exam: safeExam, participant: { name: link.participantName, email: link.participantEmail } });
});

app.post('/api/take/:token/submit', async (req, res) => {
  const link = await Link.findOne({ token: req.params.token });
  if (!link) return res.status(404).json({ error: 'Invalid link' });
  const existing = await Submission.findOne({ token: req.params.token });
  if (existing) return res.status(409).json({ error: 'Exam already submitted' });
  const exam = await Exam.findOne({ id: link.examId });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const { answers, googleName, googleEmail } = req.body;
  if (!answers) return res.status(400).json({ error: 'answers[] required' });

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
      return { questionId: q.id, type: 'mcq', selectedOption, isCorrect: correct, autoPoints: pts };
    } else {
      hasSubjective = true;
      return { questionId: q.id, type: 'subjective', text: ans ? ans.text : '', manualPoints: null, feedback: null };
    }
  });

  const submission = await Submission.create({
    id: uuidv4(), token: req.params.token, examId: link.examId, examTitle: exam.title,
    participantName: googleName || link.participantName, participantEmail: googleEmail || link.participantEmail,
    googleName: googleName || null, googleEmail: googleEmail || null,
    answers: gradedAnswers, autoPoints: autoTotal,
    totalPoints: hasSubjective ? undefined : autoTotal,
    maxPoints, status: hasSubjective ? 'pending_review' : 'graded',
    gradedAt: hasSubjective ? undefined : new Date(),
  });

  link.used = true;
  await link.save();
  await appendToSheet(submission, exam);

  res.json({ success: true, submissionId: submission.id, status: submission.status, autoPoints: submission.autoPoints, totalPoints: submission.totalPoints, maxPoints: submission.maxPoints });
});

// ===================== SUBMISSIONS =====================

app.get('/api/submissions', adminAuth, async (req, res) => {
  const { examId, status } = req.query;
  const filter = {};
  if (examId) filter.examId = examId;
  if (status) filter.status = status;
  const subs = await Submission.find(filter).sort({ submittedAt: -1 });
  res.json(subs);
});

app.get('/api/submissions/:id', adminAuth, async (req, res) => {
  const sub = await Submission.findOne({ id: req.params.id });
  if (!sub) return res.status(404).json({ error: 'Not found' });
  const exam = await Exam.findOne({ id: sub.examId });
  res.json({ submission: sub, exam });
});

app.post('/api/submissions/:id/grade', adminAuth, async (req, res) => {
  const sub = await Submission.findOne({ id: req.params.id });
  if (!sub) return res.status(404).json({ error: 'Not found' });
  const { grades } = req.body;
  if (!grades) return res.status(400).json({ error: 'grades[] required' });

  grades.forEach(g => {
    const ans = sub.answers.find(a => a.questionId === g.questionId);
    if (ans && ans.type === 'subjective') { ans.manualPoints = g.points; ans.feedback = g.feedback || null; }
  });

  const allGraded = sub.answers.every(a => a.type === 'mcq' || (a.type === 'subjective' && a.manualPoints != null));
  if (allGraded) {
    sub.totalPoints = sub.answers.reduce((sum, a) => sum + (a.type === 'mcq' ? a.autoPoints : (a.manualPoints || 0)), 0);
    sub.status = 'graded';
    sub.gradedAt = new Date();
  }

  await sub.save();
  const exam = await Exam.findOne({ id: sub.examId });
  await updateSheetRow(sub, exam);
  res.json(sub);
});

app.get('/api/result/:submissionId', async (req, res) => {
  const sub = await Submission.findOne({ id: req.params.submissionId });
  if (!sub) return res.status(404).json({ error: 'Not found' });
  const exam = await Exam.findOne({ id: sub.examId });
  res.json({ submission: sub, exam });
});

// ===================== EXPORT =====================

app.get('/api/export/:examId', adminAuth, async (req, res) => {
  const exam = await Exam.findOne({ id: req.params.examId });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const submissions = await Submission.find({ examId: req.params.examId });

  const headers = ['Name', 'Email', 'Submitted At', 'Status', 'Total Points', 'Max Points', 'Score %',
    ...exam.questions.map((q, i) => `Q${i+1}: ${q.text.substring(0,40)}`),
    ...exam.questions.map((q, i) => `Q${i+1} Points`)];

  const rows = submissions.map(s => {
    const answerTexts = exam.questions.map(q => { const ans = s.answers.find(a => a.questionId === q.id); if (!ans) return ''; return q.type === 'mcq' ? (q.options[ans.selectedOption] ?? '') : (ans.text || ''); });
    const answerPoints = exam.questions.map(q => { const ans = s.answers.find(a => a.questionId === q.id); if (!ans) return ''; return q.type === 'mcq' ? ans.autoPoints : (ans.manualPoints ?? 'Pending'); });
    return [s.participantName, s.participantEmail, s.submittedAt, s.status, s.totalPoints ?? 'Pending', s.maxPoints, s.totalPoints != null ? ((s.totalPoints/s.maxPoints)*100).toFixed(1)+'%' : 'Pending', ...answerTexts, ...answerPoints];
  });

  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${exam.title.replace(/[^a-z0-9]/gi,'_')}_results.csv"`);
  res.send(csv);
});

// ===================== OPEN EXAM (single shareable link) =====================

app.get('/api/open/:examId/check', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.json({ submitted: false });
  const existing = await Submission.findOne({ examId: req.params.examId, googleEmail: email });
  if (existing) return res.json({ submitted: true, submissionId: existing.id });
  res.json({ submitted: false });
});

app.get('/api/open/:examId', async (req, res) => {
  const exam = await Exam.findOne({ id: req.params.examId });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const safeExam = { ...exam.toObject(), questions: exam.questions.map(q => ({ id: q.id, type: q.type, text: q.text, options: q.options, maxPoints: q.maxPoints, order: q.order })) };
  res.json({ exam: safeExam });
});

app.post('/api/open/:examId/submit', async (req, res) => {
  const exam = await Exam.findOne({ id: req.params.examId });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const { answers, googleName, googleEmail } = req.body;
  if (!answers || !googleEmail) return res.status(400).json({ error: 'answers and googleEmail required' });

  const existing = await Submission.findOne({ examId: req.params.examId, googleEmail });
  if (existing) return res.status(409).json({ error: 'Already submitted', submission: { id: existing.id, status: existing.status } });

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
      return { questionId: q.id, type: 'mcq', selectedOption, isCorrect: correct, autoPoints: pts };
    } else {
      hasSubjective = true;
      return { questionId: q.id, type: 'subjective', text: ans ? ans.text : '', manualPoints: null, feedback: null };
    }
  });

  const submission = await Submission.create({
    id: uuidv4(), token: null, examId: exam.id, examTitle: exam.title,
    participantName: googleName, participantEmail: googleEmail,
    googleName, googleEmail,
    answers: gradedAnswers, autoPoints: autoTotal,
    totalPoints: hasSubjective ? undefined : autoTotal,
    maxPoints, status: hasSubjective ? 'pending_review' : 'graded',
    gradedAt: hasSubjective ? undefined : new Date(),
  });

  await appendToSheet(submission, exam);
  res.json({ success: true, submissionId: submission.id, status: submission.status, autoPoints: submission.autoPoints, totalPoints: submission.totalPoints, maxPoints: submission.maxPoints });
});

// ===================== SESSIONS & RESOURCES =====================

// Sessions CRUD
app.get('/api/sessions', async (req, res) => {
  const sessions = await Session.find().sort({ order: 1, createdAt: 1 });
  res.json(sessions);
});

app.post('/api/sessions', adminAuth, async (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const count = await Session.countDocuments();
  const session = await Session.create({ id: uuidv4(), title, description: description || '', order: count });
  res.json(session);
});

app.put('/api/sessions/:id', adminAuth, async (req, res) => {
  const session = await Session.findOneAndUpdate({ id: req.params.id }, req.body, { new: true });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

app.delete('/api/sessions/:id', adminAuth, async (req, res) => {
  await Session.deleteOne({ id: req.params.id });
  await Resource.deleteMany({ sessionId: req.params.id });
  res.json({ success: true });
});

// Resources per session
app.get('/api/sessions/:sessionId/resources', async (req, res) => {
  const resources = await Resource.find({ sessionId: req.params.sessionId }).sort({ createdAt: 1 }).select('-fileData');
  res.json(resources);
});

app.post('/api/sessions/:sessionId/resources', adminAuth, upload.single('file'), async (req, res) => {
  const { title, description, type, url } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const session = await Session.findOne({ id: req.params.sessionId });
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const data = { id: uuidv4(), sessionId: req.params.sessionId, title, description: description || '', type: type || 'other' };
  if (req.file) {
    data.fileName = req.file.originalname;
    data.fileData = req.file.buffer;
    data.fileMimeType = req.file.mimetype;
    data.fileSize = req.file.size;
  } else if (url) {
    data.url = url;
  } else {
    return res.status(400).json({ error: 'Either a file or a URL is required' });
  }

  const resource = await Resource.create(data);
  const { fileData, ...safe } = resource.toObject();
  res.json(safe);
});

app.delete('/api/sessions/:sessionId/resources/:id', adminAuth, async (req, res) => {
  await Resource.deleteOne({ id: req.params.id, sessionId: req.params.sessionId });
  res.json({ success: true });
});

app.get('/api/resources/:id/download', async (req, res) => {
  const resource = await Resource.findOne({ id: req.params.id });
  if (!resource || !resource.fileData) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', resource.fileMimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${resource.fileName}"`);
  res.send(resource.fileData);
});

// ===================== STATIC ROUTES =====================

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/exam/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'exam.html')));
app.get('/open/:examId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'open-exam.html')));
app.get('/review', (req, res) => res.sendFile(path.join(__dirname, 'public', 'review.html')));
app.get('/result/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'result.html')));
app.get('/resources', (req, res) => res.sendFile(path.join(__dirname, 'public', 'resources.html')));

// ===================== START =====================

initSheets();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🎓 Certification Platform running at http://localhost:${PORT}`);
    console.log(`   Admin password: ${ADMIN_PASSWORD}`);
    console.log(`   Admin panel:    http://localhost:${PORT}/`);
    console.log(`   Review page:    http://localhost:${PORT}/review\n`);
  });
}

module.exports = app;
