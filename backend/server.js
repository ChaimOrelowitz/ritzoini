require('dotenv').config();
const express = require('express');
const cors = require('cors');

const groupsRouter = require('./routes/groups');
const sessionsRouter = require('./routes/sessions');
const usersRouter = require('./routes/users');

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000' }));
app.use(express.json());

// Routes
app.use('/api/groups', groupsRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/users', usersRouter);

app.get('/api/health', (req, res) => res.json({ status: 'ok', app: 'Ritzoini API' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Ritzoini API running on port ${PORT}`));
