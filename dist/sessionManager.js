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
exports.handleCallConnection = handleCallConnection;
exports.handleFrontendConnection = handleFrontendConnection;
const ws_1 = require("ws");
const dotenv_1 = __importDefault(require("dotenv"));
const functionHandlers_1 = __importDefault(require("./functionHandlers"));
dotenv_1.default.config();
let session = {};
function handleCallConnection(ws, openAIApiKey) {
    cleanupConnection(session.twilioConn);
    session.twilioConn = ws;
    session.openAIApiKey = openAIApiKey;
    ws.on("message", handleTwilioMessage);
    ws.on("error", ws.close);
    ws.on("close", () => {
        cleanupConnection(session.modelConn);
        cleanupConnection(session.twilioConn);
        session.twilioConn = undefined;
        session.modelConn = undefined;
        session.streamSid = undefined;
        session.lastAssistantItem = undefined;
        session.responseStartTimestamp = undefined;
        session.latestMediaTimestamp = undefined;
        if (!session.frontendConn)
            session = {};
    });
}
function handleFrontendConnection(ws) {
    cleanupConnection(session.frontendConn);
    session.frontendConn = ws;
    ws.on("message", handleFrontendMessage);
    ws.on("close", () => {
        cleanupConnection(session.frontendConn);
        session.frontendConn = undefined;
        if (!session.twilioConn && !session.modelConn)
            session = {};
    });
}
function handleFunctionCall(item) {
    return __awaiter(this, void 0, void 0, function* () {
        console.log("Handling function call:", item);
        const fnDef = functionHandlers_1.default.find((f) => f.schema.name === item.name);
        if (!fnDef) {
            throw new Error(`No handler found for function: ${item.name}`);
        }
        let args;
        try {
            args = JSON.parse(item.arguments);
        }
        catch (_a) {
            return JSON.stringify({
                error: "Invalid JSON arguments for function call.",
            });
        }
        try {
            console.log("Calling function:", fnDef.schema.name, args);
            const result = yield fnDef.handler(args);
            return result;
        }
        catch (err) {
            console.error("Error running function:", err);
            return JSON.stringify({
                error: `Error running function ${item.name}: ${err.message}`,
            });
        }
    });
}
function handleTwilioMessage(data) {
    const msg = parseMessage(data);
    if (!msg)
        return;
    switch (msg.event) {
        case "start":
            session.streamSid = msg.start.streamSid;
            session.latestMediaTimestamp = 0;
            session.lastAssistantItem = undefined;
            session.responseStartTimestamp = undefined;
            tryConnectModel();
            break;
        case "media":
            session.latestMediaTimestamp = msg.media.timestamp;
            if (isOpen(session.modelConn)) {
                jsonSend(session.modelConn, {
                    type: "input_audio_buffer.append",
                    audio: msg.media.payload,
                });
            }
            break;
        case "close":
            closeAllConnections();
            break;
    }
}
function handleFrontendMessage(data) {
    const msg = parseMessage(data);
    if (!msg)
        return;
    if (isOpen(session.modelConn)) {
        jsonSend(session.modelConn, msg);
    }
    if (msg.type === "session.update") {
        session.saved_config = msg.session;
    }
}
function tryConnectModel() {
    if (!session.twilioConn || !session.streamSid || !session.openAIApiKey)
        return;
    if (isOpen(session.modelConn))
        return;
    session.modelConn = new ws_1.WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
        headers: {
            Authorization: `Bearer ${session.openAIApiKey}`,
            "OpenAI-Beta": "realtime=v1",
        },
    });
    session.modelConn.on("open", () => __awaiter(this, void 0, void 0, function* () {
        const config = session.saved_config || {};
        const remoteConfig = yield fetchRemoteAgentConfig(config);
        const instructions = remoteConfig.instructions ||
            process.env.AGENT_SYSTEM_PROMPT ||
            "You are a realtime voice assistant with tool and memory access.Always speak in Hindi and Proactively use available tools (including vector memory search and storage) to help the user. Keep responses concise, speak naturally, and retrieve relevant memories before answering complex or contextual questions. When you call store_memory or search_memory, always pass client_id and agent_id so that memories are partitioned and retrieved per client and agent persona.";
        const voice = remoteConfig.voice || "ash";
        const clientId = remoteConfig.client_id || config.client_id;
        const agentId = remoteConfig.agent_id || config.agent_id || "sales_agent";
        jsonSend(session.modelConn, {
            type: "session.update",
            session: Object.assign({ modalities: ["text", "audio"], turn_detection: { type: "server_vad" }, voice, input_audio_transcription: { model: "whisper-1" }, input_audio_format: "g711_ulaw", output_audio_format: "g711_ulaw", instructions, metadata: Object.assign(Object.assign(Object.assign({}, config.metadata), (clientId ? { client_id: clientId } : {})), (agentId ? { agent_id: agentId } : {})), tools: functionHandlers_1.default.map((f) => f.schema) }, config),
        });
    }));
    session.modelConn.on("message", handleModelMessage);
    session.modelConn.on("error", closeModel);
    session.modelConn.on("close", closeModel);
}
function handleModelMessage(data) {
    const event = parseMessage(data);
    if (!event)
        return;
    jsonSend(session.frontendConn, event);
    switch (event.type) {
        case "input_audio_buffer.speech_started":
            handleTruncation();
            break;
        case "response.audio.delta":
            if (session.twilioConn && session.streamSid) {
                if (session.responseStartTimestamp === undefined) {
                    session.responseStartTimestamp = session.latestMediaTimestamp || 0;
                }
                if (event.item_id)
                    session.lastAssistantItem = event.item_id;
                jsonSend(session.twilioConn, {
                    event: "media",
                    streamSid: session.streamSid,
                    media: { payload: event.delta },
                });
                jsonSend(session.twilioConn, {
                    event: "mark",
                    streamSid: session.streamSid,
                });
            }
            break;
        case "response.output_item.done": {
            const { item } = event;
            if (item.type === "function_call") {
                handleFunctionCall(item)
                    .then((output) => {
                    if (session.modelConn) {
                        jsonSend(session.modelConn, {
                            type: "conversation.item.create",
                            item: {
                                type: "function_call_output",
                                call_id: item.call_id,
                                output: JSON.stringify(output),
                            },
                        });
                        jsonSend(session.modelConn, { type: "response.create" });
                    }
                })
                    .catch((err) => {
                    console.error("Error handling function call:", err);
                });
            }
            break;
        }
    }
}
function handleTruncation() {
    if (!session.lastAssistantItem ||
        session.responseStartTimestamp === undefined)
        return;
    const elapsedMs = (session.latestMediaTimestamp || 0) - (session.responseStartTimestamp || 0);
    const audio_end_ms = elapsedMs > 0 ? elapsedMs : 0;
    if (isOpen(session.modelConn)) {
        jsonSend(session.modelConn, {
            type: "conversation.item.truncate",
            item_id: session.lastAssistantItem,
            content_index: 0,
            audio_end_ms,
        });
    }
    if (session.twilioConn && session.streamSid) {
        jsonSend(session.twilioConn, {
            event: "clear",
            streamSid: session.streamSid,
        });
    }
    session.lastAssistantItem = undefined;
    session.responseStartTimestamp = undefined;
}
function closeModel() {
    cleanupConnection(session.modelConn);
    session.modelConn = undefined;
    if (!session.twilioConn && !session.frontendConn)
        session = {};
}
function closeAllConnections() {
    if (session.twilioConn) {
        session.twilioConn.close();
        session.twilioConn = undefined;
    }
    if (session.modelConn) {
        session.modelConn.close();
        session.modelConn = undefined;
    }
    if (session.frontendConn) {
        session.frontendConn.close();
        session.frontendConn = undefined;
    }
    session.streamSid = undefined;
    session.lastAssistantItem = undefined;
    session.responseStartTimestamp = undefined;
    session.latestMediaTimestamp = undefined;
    session.saved_config = undefined;
}
function fetchRemoteAgentConfig(baseConfig) {
    return __awaiter(this, void 0, void 0, function* () {
        let remoteConfig = {};
        try {
            const response = yield fetch("https://dummy-agent-config-service.local/api/agent-config", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    client_id: (baseConfig === null || baseConfig === void 0 ? void 0 : baseConfig.client_id) || "demo-client-id",
                    agent_id: (baseConfig === null || baseConfig === void 0 ? void 0 : baseConfig.agent_id) || "sales_agent",
                }),
            });
            if (response.ok) {
                remoteConfig = yield response.json();
            }
        }
        catch (err) {
            console.error("Failed to fetch remote agent config", err);
        }
        return remoteConfig || {};
    });
}
function cleanupConnection(ws) {
    if (isOpen(ws))
        ws.close();
}
function parseMessage(data) {
    try {
        return JSON.parse(data.toString());
    }
    catch (_a) {
        return null;
    }
}
function jsonSend(ws, obj) {
    if (!isOpen(ws))
        return;
    ws.send(JSON.stringify(obj));
}
function isOpen(ws) {
    return !!ws && ws.readyState === ws_1.WebSocket.OPEN;
}
