# Complete Setup Instructions for AI-Driven Task Management System

## Prerequisites

Before you start, make sure you have installed:

1. **Node.js** (version 18 or higher) - Download from [nodejs.org](https://nodejs.org/)
2. **MongoDB** - Download from [mongodb.com](https://www.mongodb.com/try/download/community) OR use MongoDB Atlas (cloud)
3. **Google Gemini API Key** - Get from [Google AI Studio](https://makersuite.google.com/app/apikey)

---

## Step 1: Install MongoDB (if using local)

### Option A: Local MongoDB

1. Download MongoDB Community Server from mongodb.com
2. Install it (default location: `C:\Program Files\MongoDB\Server\...`)
3. MongoDB will run automatically as a Windows service

### Option B: MongoDB Atlas (Cloud - Recommended)

1. Go to [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas)
2. Create a free account
3. Create a free cluster
4. Get your connection string (looks like: `mongodb+srv://username:password@cluster.mongodb.net/...`)

---

## Step 2: Get Google Gemini API Key

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Sign in with your Google account
3. Click "Create API Key"
4. Copy the API key (looks like: `AIza...`)
5. **Important**: Note which model you want to use. Recommended: `gemini-2.5-flash` or `gemini-2.5-flash-lite`

---

## Step 3: Backend Setup

### 3.1 Navigate to Server Folder

Open PowerShell or Command Prompt and run:

```bash
cd "C:\Users\Bhanu\Desktop\AI-Driven Task Management with Productivity Pattern Research\server"
```

### 3.2 Install Backend Dependencies

```bash
npm install
```

This will install all required packages (express, mongoose, socket.io, etc.)

### 3.3 Create Backend Environment File

Create a file named `.env` in the `server` folder with this content:

```env
MONGODB_URI=mongodb://localhost:27017/jobportal
PORT=5000
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=llama-3.1-8b-instant
```

**Replace:**

- `your_groq_api_key_here` with your actual Groq API key
- If using MongoDB Atlas, replace `MONGODB_URI` with your Atlas connection string
- `GROQ_MODEL` can be `llama-3.1-8b-instant` (default) or another supported Groq chat model

### 3.4 Seed Demo Data

Run this command to create demo employees and tasks:

```bash
node ./seeds/seedDemoData.js
```

You should see:

```
Connected to MongoDB for seeding
Seeded employee e@e.com with 20 tasks
Seeded employee ravi@example.com with 20 tasks
...
Seeding complete.
```

### 3.5 Start Backend Server

```bash
npm run dev
```

You should see:

```
MongoDB connected successfully
Server running on port 5000
```

**Keep this terminal window open!** The server must stay running.

---

## Step 4: Frontend Setup

### 4.1 Open a NEW Terminal Window

Keep the backend running, open a new PowerShell/Command Prompt window.

### 4.2 Navigate to Client Folder

```bash
cd "C:\Users\Bhanu\Desktop\AI-Driven Task Management with Productivity Pattern Research\client"
```

### 4.3 Install Frontend Dependencies

```bash
npm install
```

This will install React, Vite, Chart.js, Socket.io client, etc.

### 4.4 Create Frontend Environment File

Create a file named `.env` in the `client` folder with this content:

```env
VITE_API_URL=http://localhost:5000
```

**Important:** Make sure this matches your backend port (default is 5000).

### 4.5 Start Frontend Development Server

```bash
npm run dev
```

You should see:

```
VITE v5.x.x  ready in xxx ms

➜  Local:   http://localhost:5173/
➜  Network: use --host to expose
```

**Keep this terminal window open too!**

---

## Step 5: Access the Application

1. Open your web browser
2. Go to: `http://localhost:5173` (or the URL shown in your terminal)
3. You should see the login page

---

## Step 6: Login Credentials

### Employee Login (Demo User)

- **Email:** `e@e.com`
- **Password:** `123`

### Admin Login

- Use the admin credentials you set up (or check your database)

---

## Step 7: Verify Everything Works

### Test AI Features:

1. **Login as employee** (`e@e.com` / `123`)
2. Click **"Explain Task (AI)"** on any task
3. You should see an AI-generated explanation with steps
4. Check the **Productivity Dashboard** - graphs should show data
5. Look for **"AI Suggested Priority"** badges on tasks

### Test Admin Features:

1. **Login as admin**
2. Check **Productivity Leaderboard** - should show ranked employees
3. Check **AI Notes & Logs** panel - should show real-time task updates
4. Check **Individual Employee Productivity Graphs** - should show charts for each employee

---

## Troubleshooting

### Problem: "MongoDB connection error"

**Solution:**

- Make sure MongoDB is running (check Windows Services)
- Or verify your MongoDB Atlas connection string is correct
- Check `MONGODB_URI` in `server/.env`

### Problem: "Failed to fetch explanation" or 503 errors

**Solution:**

- Check `GROQ_API_KEY` in `server/.env` is correct
- Try changing `GROQ_MODEL` to another available Groq model if one is rate-limited
- Wait a few seconds between AI requests (rate limiting)

### Problem: "Cannot find module" errors

**Solution:**

- Run `npm install` again in both `server` and `client` folders
- Delete `node_modules` folder and `package-lock.json`, then run `npm install` again

### Problem: Frontend shows "Failed to load resource"

**Solution:**

- Check `VITE_API_URL` in `client/.env` matches your backend URL
- Make sure backend is running on port 5000
- Restart both frontend and backend

### Problem: Graphs are flat or show no data

**Solution:**

- Run the seed script again: `cd server && node ./seeds/seedDemoData.js`
- Make sure tasks have completion timestamps (seed script adds these)

### Problem: Real-time updates not working

**Solution:**

- Check both backend and frontend are running
- Check browser console for WebSocket errors
- Make sure `VITE_API_URL` in frontend matches backend URL

---

## What Each Feature Does

### AI Features:

- **AI Priority Detection**: Automatically sets task priority (High/Medium/Low) based on title and description
- **AI Task Explanation**: Generates step-by-step guidance for completing tasks
- **AI Productivity Insights**: Personalized insights for each employee based on their performance
- **AI Admin Recommendations**: AI-generated recommendations for managers

### Real-time Features:

- **Socket.io**: Updates appear instantly without page refresh
- **Live Graphs**: Charts update automatically when tasks are completed
- **Live AI Guidance**: AI explanations appear immediately after generation

### Analytics Features:

- **Productivity Dashboard**: Shows completion times, on-time rates, peak hours
- **Productivity Leaderboard**: Ranks employees by performance
- **Individual Graphs**: Per-employee productivity charts and trends

---

## File Structure

```
project/
├── server/
│   ├── .env                    # Backend environment variables
│   ├── server.js               # Main server file
│   ├── models.js               # Database models
│   ├── api/
│   │   ├── gemini/             # AI/Gemini integration
│   │   └── productivityRoutes.js
│   ├── seeds/
│   │   └── seedDemoData.js     # Demo data generator
│   └── package.json
│
├── client/
│   ├── .env                    # Frontend environment variables
│   ├── src/
│   │   ├── components/
│   │   │   ├── Dashboard/      # Admin & Employee dashboards
│   │   │   └── TaskList/       # Task components
│   │   └── context/
│   │       └── AuthProvider.jsx
│   └── package.json
│
└── SETUP_INSTRUCTIONS.md       # This file
```

---

## Daily Usage

### Starting the Application:

1. Start MongoDB (if local) or ensure Atlas is accessible
2. Open terminal 1: `cd server && npm run dev`
3. Open terminal 2: `cd client && npm run dev`
4. Open browser: `http://localhost:5173`

### Stopping the Application:

- Press `Ctrl+C` in both terminal windows
- Close browser tabs

---

## Next Steps

1. **Customize Demo Data**: Edit `server/seeds/seedDemoData.js` to add your own tasks
2. **Add More Employees**: Use the seed script or create via admin panel
3. **Adjust AI Prompts**: Edit `server/api/gemini/geminiPrompts.js` to change AI behavior
4. **Deploy**: When ready, deploy backend to services like Render/Railway, frontend to Vercel/Netlify

---

## Support

If you encounter issues:

1. Check the troubleshooting section above
2. Check terminal output for error messages
3. Check browser console (F12) for frontend errors
4. Verify all environment variables are set correctly

---

**That's it! Your AI-Driven Task Management System is ready to use! 🚀**
