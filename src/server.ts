import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import dotenv from "dotenv";
import http from "http";
import { readFileSync } from "fs";
import { join } from "path";
import cors from "cors";
import mongoose from "mongoose";
import { CallLog } from "./models/CallLog";
import {
  handleCallConnection,
  handleFrontendConnection,
  invalidateAgentConfig,
  handleVonageConnection,
  getSessionsSummary,
} from "./sessionManager";
import functions from "./functionHandlers";

dotenv.config();

const PORT = parseInt(process.env.PORT || "8080", 10);
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/websocket-server";

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("[DB] Connected to MongoDB");
  })
  .catch((err) => {
    console.error("[DB] MongoDB connection error", err);
  });

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.urlencoded({ extended: false }));

const twimlPath = join(__dirname, "twiml.xml");
const twimlTemplate = readFileSync(twimlPath, "utf-8");

app.get("/public-url", (req, res) => {
  res.json({ publicUrl: PUBLIC_URL });
});

// Invalidate in-memory agent config cache when Acharya config is updated
app.post("/agent-config/invalidate", (req:any, res:any) => {
  const { agentCode, customerId } = req.body || {};
  if (!agentCode) {
    return res.status(400).json({ error: "agentCode is required" });
  }
  invalidateAgentConfig(agentCode, customerId);
  res.json({ status: "ok" });
});

app.all("/twiml", async (req, res) => {
  const wsUrl = new URL(PUBLIC_URL);
  wsUrl.protocol = "wss:";
  wsUrl.pathname = `/call`;
  console.log("[TWILIO] Incoming /twiml payload", req.body);
  console.log("[TWILIO] query params", req.query);
  try {
    await CallLog.create({
      ...req.body,
      rawPayload: req.body,
      agentCode: req.query.code,
    });
  } catch (err) {
    console.error("[TWILIO] Failed to persist CallLog", err);
  }
  const sessionId = (req.query.session_id as string) || "session-default";
  const customer = (req.query.customer as string) || "customer-default";
  const agentCode = (req.query.code as string) || "agent-code-default";

  const twimlContent = twimlTemplate
    .replace("{{WS_URL}}", wsUrl.toString())
    .replace("{{SESSION_ID}}", sessionId)
    .replace("{{CUSTOMER}}", customer)
    .replace("{{CODE}}", agentCode.toString());
  res.type("text/xml").send(twimlContent);
});

app.all("/vonage/ncco", async (req, res) => {
  const wsUrl = new URL(PUBLIC_URL);
  wsUrl.protocol = "wss:";
  wsUrl.pathname = `/vonage-call`;
  const sessionId = (req.query.session_id as string) || "session-default";
  const customer = (req.query.customer as string) || "customer-default";
  const agentCode = (req.query.code as string) || "agent-code-default";

  wsUrl.searchParams.set("session_id", sessionId);
  wsUrl.searchParams.set("customer", customer);
  wsUrl.searchParams.set("code", agentCode.toString());

  const ncco = [
    {
      action: "talk",
      text: "Please wait while we connect you to the AI assistant.",
    },
    {
      action: "connect",
      endpoint: [
        {
          type: "websocket",
          uri: wsUrl.toString(),
          "content-type": "audio/l16;rate=16000",
          headers: {
            session_id: sessionId,
            customer,
            code: agentCode.toString(),
          },
        },
      ],
    },
  ];

  res.json(ncco);
});

// New endpoint to list available tools (schemas)
app.get("/tools", (req, res) => {
  res.json(functions.map((f) => f.schema));
});

app.get("/sessions", (req, res) => {
  res.json(getSessionsSummary());
});

//IncomingMessage
wss.on("connection", (ws: WebSocket, req: any) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);
  var FullURL = req;
  console.log(FullURL);
  if (parts.length < 1) {
    ws.close();
    return;
  }

  const type = parts[0];
  const sessionId = url.searchParams.get("session_id") || "session-default";
  const customer = url.searchParams.get("customer") || "customer-default";
  const agentCode = url.searchParams.get("code") || "agent-code-default";

  if (type === "call") {
    handleCallConnection(ws, OPENAI_API_KEY, {
      sessionId,
      customer,
      code: agentCode,
    });
  } else if (type === "vonage-call") {
    handleVonageConnection(ws, OPENAI_API_KEY, {
      sessionId,
      customer,
      code: agentCode,
    });
  } else if (type === "logs") {
    handleFrontendConnection(ws, { sessionId });
  } else {
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
