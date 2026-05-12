# AI-Driven Task Management

Full-stack task management with admin and employee dashboards, productivity analytics, and AI-assisted task guidance (Groq). MongoDB stores all data.

## Repository layout

```
├── api/index.js          # Vercel serverless entry → Express app
├── client/               # Vite + React SPA
│   └── dist/             # Production build output
├── server/               # Express API, models, routes
└── vercel.json           # Vercel build + rewrites
```

## Local development

1. **Install**

   ```sh
   npm install
   cd client && npm install && cd ..
   ```

2. **Environment**

   Copy `.env.example` to `.env` at the repo root and set at least `MONGODB_URI` and `GROQ_API_KEY`. For the client talking to a local API on port 5000, you can use:

   ```env
   VITE_API_URL=http://localhost:5000
   ```

3. **Run**

   ```sh
   npm run dev:server
   ```

   In another terminal:

   ```sh
   npm run dev:client
   ```

More detail: see `SETUP_INSTRUCTIONS.md`.

## Deploy on Vercel

1. Import the repo in [Vercel](https://vercel.com).
2. **Root directory:** repository root (where `vercel.json` lives).
3. **Environment variables** (Production + Preview as needed):

   - `MONGODB_URI` — required.
   - `GROQ_API_KEY` — required for AI features.
   - Optional: `GROQ_MODEL`, Mongo timeouts (`MONGO_*` from `.env.example`).
   - **Client build:** add `VITE_API_URL` only if the API is on another origin; for same Vercel project leave unset so requests go to `/api`.
   - Keep `VITE_ENABLE_REALTIME` unset or `false` on Vercel (Socket.IO is not supported on serverless functions).

4. Deploy: Vercel uses `installCommand` and `buildCommand` from `vercel.json`; static files come from `client/dist`, and `/api/*` is handled by `api/index.js`.

## Health check

After deploy, open `/api/health` to confirm the API handler is up (database connectivity is reported there when configured).
