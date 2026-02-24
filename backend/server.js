const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://localhost:3001',
    'https://ritzoini.vercel.app',
  ],
  credentials: true,
}));

app.use(express.json());

// Routes
app.use('/api/groups',      require('./routes/groups'));
app.use('/api/sessions',    require('./routes/sessions'));
app.use('/api/users',       require('./routes/users'));
app.use('/api/instructors', require('./routes/instructors'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'Ritzoini API' });
});

app.listen(PORT, () => {
  console.log(`Ritzoini API running on port ${PORT}`);
});
