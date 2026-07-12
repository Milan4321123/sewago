const express = require('express');
const { db, save, uid } = require('../db');
const { authRequired, publicUser } = require('./auth');
const { recordTxn, recordPlatformRevenue } = require('../payments');

const router = express.Router();

const CATEGORIES = { shopping: '🛒', cleaning: '🧹', delivery: '📦', repair: '🔧', other: '💼' };
const PLATFORM_FEE = 0.1; // SewaGo keeps 10% of every completed task

function taskPublic(t) {
  return { ...t, icon: CATEGORIES[t.category] || '💼' };
}

router.get('/tasks/board', authRequired, (req, res) => {
  const tasks = db.tasks
    .filter((t) => t.status === 'open' && t.posterId !== req.user.id)
    .slice()
    .reverse()
    .map(taskPublic);
  res.json({ tasks });
});

router.get('/tasks/mine', authRequired, (req, res) => {
  const posted = db.tasks.filter((t) => t.posterId === req.user.id).slice().reverse().map(taskPublic);
  const working = db.tasks.filter((t) => t.workerId === req.user.id).slice().reverse().map(taskPublic);
  res.json({ posted, working });
});

router.post('/tasks', authRequired, (req, res) => {
  const { title, category, desc, place, budget } = req.body || {};
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
    budget: amount,
    fee,
    workerPayout: amount - fee,
    status: 'open',
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
  res.json({ task: taskPublic(task), user: publicUser(req.user) });
});

router.post('/tasks/:id/accept', authRequired, (req, res) => {
  const task = db.tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.posterId === req.user.id) return res.status(400).json({ error: 'You cannot accept your own task.' });
  if (task.status !== 'open') return res.status(409).json({ error: 'This task was already taken.' });
  task.status = 'assigned';
  task.workerId = req.user.id;
  task.workerName = req.user.name;
  task.assignedAt = Date.now();
  save();
  res.json({ task: taskPublic(task) });
});

router.post('/tasks/:id/done', authRequired, (req, res) => {
  const task = db.tasks.find((t) => t.id === req.params.id && t.workerId === req.user.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'assigned') return res.status(400).json({ error: 'This task is not in progress.' });
  task.status = 'done'; // waiting for the poster to confirm and release payment
  task.doneAt = Date.now();
  save();
  res.json({ task: taskPublic(task) });
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
  res.json({ task: taskPublic(task), user: publicUser(req.user) });
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
  res.json({ task: taskPublic(task), user: publicUser(req.user) });
});

module.exports = router;
