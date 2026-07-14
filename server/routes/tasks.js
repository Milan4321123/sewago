const express = require('express');
const { db, save, uid } = require('../db');
const { authRequired, publicUser } = require('./auth');
const { recordTxn, recordPlatformRevenue } = require('../payments');

const router = express.Router();

const CATEGORIES = { shopping: '🛒', cleaning: '🧹', delivery: '📦', repair: '🔧', other: '💼' };
const PLATFORM_FEE = 0.1; // SewaGo keeps 10% of every completed task

// Applicant details (names, pitches) are only shown to the poster; everyone
// else just sees how many people applied and whether they applied themselves.
function taskPublic(t, viewerId = null) {
  const applicants = t.applicants || [];
  const out = {
    ...t,
    icon: CATEGORIES[t.category] || '💼',
    applicantCount: applicants.length,
    applied: viewerId ? applicants.some((a) => a.userId === viewerId) : false
  };
  if (viewerId !== t.posterId) delete out.applicants;
  return out;
}

function completedJobs(userId) {
  return db.tasks.filter((t) => t.workerId === userId && t.status === 'completed').length;
}

router.get('/tasks/board', authRequired, (req, res) => {
  const tasks = db.tasks
    .filter((t) => t.status === 'open' && t.posterId !== req.user.id)
    .slice()
    .reverse()
    .map((t) => taskPublic(t, req.user.id));
  res.json({ tasks });
});

router.get('/tasks/mine', authRequired, (req, res) => {
  const posted = db.tasks.filter((t) => t.posterId === req.user.id).slice().reverse().map((t) => taskPublic(t, req.user.id));
  const working = db.tasks.filter((t) => t.workerId === req.user.id).slice().reverse().map((t) => taskPublic(t, req.user.id));
  res.json({ posted, working });
});

router.post('/tasks', authRequired, (req, res) => {
  const { title, category, desc, place, budget, when } = req.body || {};
  const amount = Math.round(Number(budget));
  if (!title || String(title).trim().length < 4 || String(title).trim().length > 80) {
    return res.status(400).json({ error: 'Title must be 4-80 characters.' });
  }
  if (!CATEGORIES[category]) return res.status(400).json({ error: 'Pick a valid category.' });
  if (!(amount >= 100 && amount <= 50000)) {
    return res.status(400).json({ error: 'Budget must be between Rs 100 and Rs 50,000.' });
  }
  if (req.user.wallet < amount) {
    return res.status(402).json({ error: 'Not enough wallet balance — the budget is held until the job is done.' });
  }
  const openCount = db.tasks.filter((t) => t.posterId === req.user.id && ['open', 'assigned', 'done'].includes(t.status)).length;
  if (openCount >= 5) return res.status(400).json({ error: 'You can have at most 5 active tasks.' });

  const fee = Math.round(amount * PLATFORM_FEE);
  const task = {
    id: uid(),
    posterId: req.user.id,
    posterName: req.user.name,
    title: String(title).trim(),
    category,
    desc: String(desc || '').trim().slice(0, 400),
    place: String(place || '').trim().slice(0, 60),
    when: String(when || '').trim().slice(0, 40),
    budget: amount,
    fee,
    workerPayout: amount - fee,
    status: 'open',
    applicants: [],
    workerId: null,
    workerName: null,
    createdAt: Date.now()
  };
  req.user.wallet -= amount; // held in escrow until confirmed
  recordTxn('user', req.user, {
    type: 'task_hold',
    label: `Task budget held: ${task.title}`,
    amount,
    sign: -1,
    refId: task.id
  });
  db.tasks.push(task);
  save();
  res.json({ task: taskPublic(task, req.user.id), user: publicUser(req.user) });
});

// A real hiring flow instead of first-tap-wins: workers apply with a short
// pitch, the poster reviews them and hires one.
router.post('/tasks/:id/apply', authRequired, (req, res) => {
  const task = db.tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.posterId === req.user.id) return res.status(400).json({ error: 'You cannot apply to your own task.' });
  if (task.status !== 'open') return res.status(409).json({ error: 'This task is no longer open.' });
  task.applicants = task.applicants || [];
  if (task.applicants.some((a) => a.userId === req.user.id)) {
    return res.status(409).json({ error: 'You already applied — the poster will pick soon.' });
  }
  if (task.applicants.length >= 20) return res.status(409).json({ error: 'This task already has 20 applicants.' });
  task.applicants.push({
    userId: req.user.id,
    name: req.user.name,
    note: String((req.body || {}).note || '').trim().slice(0, 200),
    completedJobs: completedJobs(req.user.id),
    appliedAt: Date.now()
  });
  save();
  res.json({ task: taskPublic(task, req.user.id) });
});

router.post('/tasks/:id/hire', authRequired, (req, res) => {
  const task = db.tasks.find((t) => t.id === req.params.id && t.posterId === req.user.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'This task already has a worker.' });
  const applicant = (task.applicants || []).find((a) => a.userId === (req.body || {}).userId);
  if (!applicant) return res.status(400).json({ error: 'Pick one of the applicants.' });
  task.status = 'assigned';
  task.workerId = applicant.userId;
  task.workerName = applicant.name;
  task.assignedAt = Date.now();
  save();
  res.json({ task: taskPublic(task, req.user.id) });
});

router.post('/tasks/:id/done', authRequired, (req, res) => {
  const task = db.tasks.find((t) => t.id === req.params.id && t.workerId === req.user.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'assigned') return res.status(400).json({ error: 'This task is not in progress.' });
  task.status = 'done'; // waiting for the poster to confirm and release payment
  task.doneAt = Date.now();
  save();
  res.json({ task: taskPublic(task, req.user.id) });
});

router.post('/tasks/:id/confirm', authRequired, (req, res) => {
  const task = db.tasks.find((t) => t.id === req.params.id && t.posterId === req.user.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'done') return res.status(400).json({ error: 'The worker has not marked this task done yet.' });
  const worker = db.users.find((u) => u.id === task.workerId);
  if (worker) {
    worker.wallet += task.workerPayout;
    recordTxn('user', worker, {
      type: 'task_income',
      label: `Task payment: ${task.title}`,
      amount: task.workerPayout,
      sign: 1,
      refId: task.id
    });
  }
  task.status = 'completed';
  task.completedAt = Date.now();
  recordPlatformRevenue({
    source: 'task_fee',
    label: `Task fee: ${task.title}`,
    amount: task.fee,
    refId: task.id
  });
  save();
  res.json({ task: taskPublic(task, req.user.id), user: publicUser(req.user) });
});

router.post('/tasks/:id/cancel', authRequired, (req, res) => {
  const task = db.tasks.find((t) => t.id === req.params.id && t.posterId === req.user.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') {
    return res.status(400).json({ error: 'Someone already accepted — you can only cancel open tasks.' });
  }
  task.status = 'cancelled';
  task.cancelledAt = Date.now();
  req.user.wallet += task.budget; // full escrow refund
  recordTxn('user', req.user, {
    type: 'task_refund',
    label: `Task cancelled — refund: ${task.title}`,
    amount: task.budget,
    sign: 1,
    refId: task.id
  });
  save();
  res.json({ task: taskPublic(task, req.user.id), user: publicUser(req.user) });
});

module.exports = router;
