import app, { connectDB } from "../server/server.js";

export default async function handler(req, res) {
  const requestPath = String(req.url || "").split("?")[0];

  try {
    // Keep health endpoint available even when DB is unreachable,
    // so deployment diagnostics can still be accessed.
    if (!requestPath.startsWith("/api/health")) {
      await connectDB();
    }

    return app(req, res);
  } catch (error) {
    const serializedError = {
      name: error?.name || "Error",
      message: error?.message || "Unknown server bootstrap error",
      code: error?.code || null,
    };

    const hasMongoUri = Boolean(process.env.MONGODB_URI);
    const looksLikeDbFailure =
      serializedError.name.includes("Mongo") ||
      /mongo|db|server selection|timed out|topology/i.test(
        serializedError.message,
      );

    console.error("Vercel API bootstrap error:", {
      path: requestPath,
      hasMongoUri,
      error: serializedError,
    });

    return res.status(looksLikeDbFailure ? 503 : 500).json({
      error: "Server bootstrap error",
      path: requestPath,
      hasMongoUri,
      hint: looksLikeDbFailure
        ? "Database connection failed during function startup. Check MONGODB_URI/Atlas access and region latency."
        : "Function initialization failed before request handling.",
      cause: serializedError,
    });
  }
}

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
    maxDuration: 30,
  },
};
