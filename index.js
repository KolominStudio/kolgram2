const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(__dirname));

const DB_FILE = path.join(__dirname, 'db.json');

// Инициализация базы
let db = { users: [], messages: [], calls: [] };
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Создание админа
(async () => {
  const exists = db.users.find(u => u.login === 'Tim');
  if (!exists) {
    const hash = await bcrypt.hash('Px+j812ba1', 10);
    db.users.push({
      id: 'admin-' + Date.now(),
      firstName: 'Тимофей',
      lastName: '',
      login: 'Tim',
      password: hash,
      isAdmin: true,
      verified: true,
      blocked: false,
      createdAt: Date.now()
    });
    saveDB();
    console.log('✅ Админ создан: Tim / Px+j812ba1');
  }
})();

// Регистрация
app.post('/api/register', async (req, res) => {
  const { firstName, lastName, login, password } = req.body;
  if (!firstName || !lastName || !login || !password)
    return res.status(400).json({ error: 'Заполните все поля' });
  if (db.users.find(u => u.login === login))
    return res.status(400).json({ error: 'Логин уже занят' });
  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: 'u-' + Date.now(),
    firstName, lastName, login,
    password: hash,
    isAdmin: false, verified: false, blocked: false,
    createdAt: Date.now()
  };
  db.users.push(user);
  saveDB();
  res.json({ ok: true });
});

// Логин
app.post('/api/login', async (req, res) => {
  const { login, password } = req.body;
  const user = db.users.find(u => u.login === login);
  if (!user) return res.status(400).json({ error: 'Неверный логин или пароль' });
  if (user.blocked) return res.status(403).json({ error: 'Аккаунт заблокирован' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Неверный логин или пароль' });
  res.json({
    user: {
      id: user.id, firstName: user.firstName, lastName: user.lastName,
      login: user.login, isAdmin: user.isAdmin,
      verified: user.verified, blocked: user.blocked
    }
  });
});

// Список пользователей (для чатов)
app.get('/api/users', (req, res) => {
  res.json(db.users.map(u => ({
    id: u.id, firstName: u.firstName, lastName: u.lastName,
    login: u.login, isAdmin: u.isAdmin,
    verified: u.verified, blocked: u.blocked
  })));
});

// Сообщения
app.get('/api/messages/:a/:b', (req, res) => {
  const { a, b } = req.params;
  const list = db.messages.filter(m =>
    (m.from === a && m.to === b) || (m.from === b && m.to === a)
  );
  res.json(list);
});

// Админ: блокировка
app.post('/api/admin/block', (req, res) => {
  const { adminId, userId } = req.body;
  const admin = db.users.find(u => u.id === adminId);
  if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Нет прав' });
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  user.blocked = !user.blocked;
  saveDB();
  res.json({ ok: true, blocked: user.blocked });
});

// Админ: верификация
app.post('/api/admin/verify', (req, res) => {
  const { adminId, userId } = req.body;
  const admin = db.users.find(u => u.id === adminId);
  if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Нет прав' });
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  user.verified = !user.verified;
  saveDB();
  res.json({ ok: true, verified: user.verified });
});

// Админ: удаление
app.post('/api/admin/delete', (req, res) => {
  const { adminId, userId } = req.body;
  const admin = db.users.find(u => u.id === adminId);
  if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Нет прав' });
  if (adminId === userId) return res.status(400).json({ error: 'Нельзя удалить себя' });
  db.users = db.users.filter(u => u.id !== userId);
  db.messages = db.messages.filter(m => m.from !== userId && m.to !== userId);
  saveDB();
  res.json({ ok: true });
});

// Socket.io — чаты, звонки, голосовые
const online = new Map(); // userId -> socketId

io.on('connection', (socket) => {
  socket.on('register', (userId) => {
    online.set(userId, socket.id);
    socket.userId = userId;
    io.emit('online', Array.from(online.keys()));
  });

  socket.on('message', (msg) => {
    db.messages.push({ ...msg, ts: Date.now() });
    saveDB();
    const toSock = online.get(msg.to);
    if (toSock) io.to(toSock).emit('message', msg);
    socket.emit('message-sent', msg);
  });

  socket.on('typing', ({ to, from }) => {
    const toSock = online.get(to);
    if (toSock) io.to(toSock).emit('typing', from);
  });

  // WebRTC signaling
  socket.on('call-offer', ({ to, from, offer, type }) => {
    const toSock = online.get(to);
    if (toSock) io.to(toSock).emit('call-offer', { from, offer, type });
  });
  socket.on('call-answer', ({ to, answer }) => {
    const toSock = online.get(to);
    if (toSock) io.to(toSock).emit('call-answer', { answer });
  });
  socket.on('ice-candidate', ({ to, candidate }) => {
    const toSock = online.get(to);
    if (toSock) io.to(toSock).emit('ice-candidate', { candidate });
  });
  socket.on('call-end', ({ to }) => {
    const toSock = online.get(to);
    if (toSock) io.to(toSock).emit('call-end');
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      online.delete(socket.userId);
      io.emit('online', Array.from(online.keys()));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 KolGram сервер запущен: http://localhost:${PORT}`);
  console.log(`📱 Kolomin Studio`);
});
