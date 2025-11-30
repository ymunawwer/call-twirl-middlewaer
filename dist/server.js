"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const ws_1 = require("ws");
const dotenv_1 = __importDefault(require("dotenv"));
const http_1 = __importDefault(require("http"));
const fs_1 = require("fs");
const path_1 = require("path");
const cors_1 = __importDefault(require("cors"));
const mongoose_1 = __importDefault(require("mongoose"));
const CallLog_1 = require("./models/CallLog");
const sessionManager_1 = require("./sessionManager");
const functionHandlers_1 = __importDefault(require("./functionHandlers"));
dotenv_1.default.config();
const PORT = parseInt(process.env.PORT || "8080", 10);
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/websocket-server";
if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY environment variable is required");
    process.exit(1);
}
mongoose_1.default
    .connect(MONGODB_URI)
    .then(() => {
    console.log("[DB] Connected to MongoDB");
})
    .catch((err) => {
    console.error("[DB] MongoDB connection error", err);
});
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
app.use(express_1.default.urlencoded({ extended: false }));
const twimlPath = (0, path_1.join)(__dirname, "twiml.xml");
const twimlTemplate = (0, fs_1.readFileSync)(twimlPath, "utf-8");
app.get("/public-url", (req, res) => {
    res.json({ publicUrl: PUBLIC_URL });
});
// Invalidate in-memory agent config cache when Acharya config is updated
app.post("/agent-config/invalidate", (req, res) => {
    const { agentCode, customerId } = req.body || {};
    if (!agentCode) {
        return res.status(400).json({ error: "agentCode is required" });
    }
    (0, sessionManager_1.invalidateAgentConfig)(agentCode, customerId);
    res.json({ status: "ok" });
});
app.all("/twiml", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const wsUrl = new URL(PUBLIC_URL);
    wsUrl.protocol = "wss:";
    wsUrl.pathname = `/call`;
    console.log("[TWILIO] Incoming /twiml payload", req.body);
    console.log("[TWILIO] query params", req.query);
    try {
        yield CallLog_1.CallLog.create(Object.assign(Object.assign({}, req.body), { rawPayload: req.body, agentCode: req.query.code }));
    }
    catch (err) {
        console.error("[TWILIO] Failed to persist CallLog", err);
    }
    const sessionId = req.query.session_id || "session-default";
    const customer = req.query.customer || "customer-default";
    const agentCode = req.query.code || "agent-code-default";
    const twimlContent = twimlTemplate
        .replace("{{WS_URL}}", wsUrl.toString())
        .replace("{{SESSION_ID}}", sessionId)
        .replace("{{CUSTOMER}}", customer)
        .replace("{{CODE}}", agentCode.toString());
    res.type("text/xml").send(twimlContent);
}));
// New endpoint to list available tools (schemas)
app.get("/tools", (req, res) => {
    res.json(functionHandlers_1.default.map((f) => f.schema));
});
let currentCall = null;
let currentLogs = null;
//IncomingMessage
wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean);
    var FullURL = req;
    console.log(FullURL);
    if (parts.length < 1) {
        ws.close();
        return;
    }
    const type = parts[0];
    if (type === "call") {
        if (currentCall)
            currentCall.close();
        currentCall = ws;
        (0, sessionManager_1.handleCallConnection)(currentCall, OPENAI_API_KEY);
    }
    else if (type === "logs") {
        if (currentLogs)
            currentLogs.close();
        currentLogs = ws;
        (0, sessionManager_1.handleFrontendConnection)(currentLogs);
    }
    else {
        ws.close();
    }
});
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
