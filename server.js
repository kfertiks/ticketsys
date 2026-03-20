const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

const db = new Database('tickets.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  flair TEXT NOT NULL DEFAULT '',
  value REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  parent_reply_id INTEGER,
  content TEXT NOT NULL,
  flair TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_reply_id) REFERENCES replies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_replies_ticket_id ON replies(ticket_id);
CREATE INDEX IF NOT EXISTS idx_replies_parent_reply_id ON replies(parent_reply_id);
`);

try {
  db.prepare(`ALTER TABLE tickets ADD COLUMN value REAL NOT NULL DEFAULT 0`).run();
} catch (error) {
  // kolumna już istnieje, więc ignorujemy
}

const ticketCount = db.prepare('SELECT COUNT(*) as count FROM tickets').get();

if (ticketCount.count === 0) {
  const insertTicket = db.prepare(`
    INSERT INTO tickets (number, title, description, flair, value)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertReply = db.prepare(`
    INSERT INTO replies (ticket_id, parent_reply_id, content, flair)
    VALUES (?, ?, ?, ?)
  `);

  const t1 = Number(
    insertTicket.run('ZAM-001', 'Podłoga dębowa dla klienta Kowalski', 'Pierwsze zamówienie testowe.', 'Nowe', 1000).lastInsertRowid
  );
  const r1 = Number(
    insertReply.run(t1, null, 'Przyjęto zamówienie do realizacji.', 'Przyjęte').lastInsertRowid
  );
  insertReply.run(t1, r1, 'Potwierdzono wymiary i kolor.', 'W produkcji');

  const t2 = Number(
    insertTicket.run('ZAM-002', 'Schody dębowe - Nowak', 'Klient pyta o termin.', 'Oczekuje', 1700).lastInsertRowid
  );
  insertReply.run(t2, null, 'Czekamy na zaliczkę.', 'Oczekuje na wpłatę');
}

function getTicketStatus(ticketId) {
  const lastReply = db.prepare(`
    SELECT flair
    FROM replies
    WHERE ticket_id = ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 1
  `).get(ticketId);

  if (lastReply && lastReply.flair) return lastReply.flair;

  const ticket = db.prepare(`SELECT flair FROM tickets WHERE id = ?`).get(ticketId);
  return (ticket && ticket.flair) || '';
}

function buildReplyTree(flatReplies) {
  const map = new Map();
  const roots = [];

  for (const reply of flatReplies) {
    map.set(reply.id, { ...reply, children: [] });
  }

  for (const reply of flatReplies) {
    const node = map.get(reply.id);
    if (reply.parent_reply_id && map.has(reply.parent_reply_id)) {
      map.get(reply.parent_reply_id).children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

app.get('/api/tickets', (_req, res) => {
  const tickets = db.prepare(`
    SELECT id, number, title, description, flair, value, created_at, updated_at
    FROM tickets
    ORDER BY datetime(updated_at) DESC, id DESC
  `).all();

  const result = tickets.map((ticket) => ({
    ...ticket,
    status: getTicketStatus(ticket.id),
  }));

  res.json(result);
});

app.delete('/api/tickets/:id', (req, res) => {
  const ticketId = Number(req.params.id);

  const exists = db.prepare(`SELECT id FROM tickets WHERE id = ?`).get(ticketId);
  if (!exists) {
    res.status(404).json({ error: 'Nie znaleziono zamówienia.' });
    return;
  }

  db.prepare(`DELETE FROM replies WHERE ticket_id = ?`).run(ticketId);
  db.prepare(`DELETE FROM tickets WHERE id = ?`).run(ticketId);

  res.json({ success: true });
});

app.get('/api/tickets/:id', (req, res) => {
  const id = Number(req.params.id);

  const ticket = db.prepare(`
    SELECT id, number, title, description, flair, value, created_at, updated_at
    FROM tickets
    WHERE id = ?
  `).get(id);

  if (!ticket) {
    res.status(404).json({ error: 'Nie znaleziono zamówienia.' });
    return;
  }

  const replies = db.prepare(`
    SELECT id, ticket_id, parent_reply_id, content, flair, created_at
    FROM replies
    WHERE ticket_id = ?
    ORDER BY datetime(created_at) ASC, id ASC
  `).all(id);

  res.json({
    ...ticket,
    status: getTicketStatus(ticket.id),
    replies: buildReplyTree(replies),
  });
});

app.post('/api/tickets', (req, res) => {
  const { number, title, description = '', flair = '', value = 0 } = req.body || {};

  console.log('BODY:', req.body);
  console.log('VALUE:', value);

  if (!number || !title) {
    res.status(400).json({ error: 'Numer i tytuł są wymagane.' });
    return;
  }

  try {
    const result = db.prepare(`
      INSERT INTO tickets (number, title, description, flair, value, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      String(number).trim(),
      String(title).trim(),
      String(description).trim(),
      String(flair).trim(),
      Number(value) || 0
    );

    const created = db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json({ ...created, status: getTicketStatus(created.id) });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      res.status(409).json({ error: 'Taki numer zamówienia już istnieje.' });
      return;
    }

    res.status(500).json({ error: 'Nie udało się dodać zamówienia.' });
  }
});

app.post('/api/tickets/:id/replies', (req, res) => {
  const ticketId = Number(req.params.id);
  const { parent_reply_id = null, content, flair = '' } = req.body || {};

  const exists = db.prepare(`SELECT id FROM tickets WHERE id = ?`).get(ticketId);
  if (!exists) {
    res.status(404).json({ error: 'Nie znaleziono zamówienia.' });
    return;
  }

  if (!content || !String(content).trim()) {
    res.status(400).json({ error: 'Treść odpowiedzi jest wymagana.' });
    return;
  }

  const result = db.prepare(`
    INSERT INTO replies (ticket_id, parent_reply_id, content, flair)
    VALUES (?, ?, ?, ?)
  `).run(ticketId, parent_reply_id, String(content).trim(), String(flair).trim());

  db.prepare(`
    UPDATE tickets
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(ticketId);

  const reply = db.prepare(`SELECT * FROM replies WHERE id = ?`).get(result.lastInsertRowid);

  res.status(201).json({
    reply,
    status: getTicketStatus(ticketId),
  });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`System działa na http://localhost:${PORT}`);
});