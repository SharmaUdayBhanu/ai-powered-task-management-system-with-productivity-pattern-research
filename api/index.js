import app, { connectDB } from "../server/server.js";

export default async function handler(req, res) {
  try {
    await connectDB();
    return app(req, res);
  } catch (error) {
    console.error("Vercel API bootstrap error:", error);
    return res.status(500).json({ error: "Server bootstrap error" });
  }
}

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
    maxDuration: 30,
  },
};
