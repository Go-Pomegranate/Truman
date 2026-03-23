import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

interface Todo { id: string; title: string; completed: boolean; createdAt: string }
const todos: Todo[] = [];
let nextId = 1;

app.get('/api/todos', (_req, res) => {
  res.json(todos);
});

app.post('/api/todos', (req, res) => {
  const todo: Todo = {
    id: String(nextId++),
    title: req.body.title ?? 'Untitled',
    completed: false,
    createdAt: new Date().toISOString(),
  };
  todos.push(todo);
  res.status(201).json(todo);
});

app.patch('/api/todos/:id', (req, res) => {
  const todo = todos.find((t) => t.id === req.params.id);
  if (!todo) return res.status(404).json({ error: 'Not found' });
  if (req.body.title !== undefined) todo.title = req.body.title;
  if (req.body.completed !== undefined) todo.completed = req.body.completed;
  res.json(todo);
});

app.delete('/api/todos/:id', (req, res) => {
  const idx = todos.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  todos.splice(idx, 1);
  res.json({ ok: true });
});

app.get('/api/todos/stats', (_req, res) => {
  res.json({
    total: todos.length,
    completed: todos.filter((t) => t.completed).length,
    pending: todos.filter((t) => !t.completed).length,
  });
});

app.listen(3000, () => console.log('TodoMVC API on http://localhost:3000'));
