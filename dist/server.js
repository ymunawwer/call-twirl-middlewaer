"use strict";
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
const sessionManager_1 = require("./sessionManager");
const functionHandlers_1 = __importDefault(require("./functionHandlers"));
dotenv_1.default.config();
const PORT = parseInt(process.env.PORT || "8081", 10);
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY environment variable is required");
    process.exit(1);
}
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
app.use(express_1.default.urlencoded({ extended: false }));
const twimlPath = (0, path_1.join)(__dirname, "twiml.xml");
const twimlTemplate = (0, fs_1.readFileSync)(twimlPath, "utf-8");
app.get("/public-url", (req, res) => {
    res.json({ publicUrl: PUBLIC_URL });
});
app.all("/twiml", (req, res) => {
    const wsUrl = new URL(PUBLIC_URL);
    wsUrl.protocol = "wss:";
    wsUrl.pathname = `/call`;
    const twimlContent = twimlTemplate.replace("{{WS_URL}}", wsUrl.toString());
    res.type("text/xml").send(twimlContent);
});
// New endpoint to list available tools (schemas)
app.get("/tools", (req, res) => {
    res.json(functionHandlers_1.default.map((f) => f.schema));
});
let currentCall = null;
let currentLogs = null;
wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean);
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
