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
exports.invalidateAgentConfig = invalidateAgentConfig;
exports.handleCallConnection = handleCallConnection;
exports.handleFrontendConnection = handleFrontendConnection;
const ws_1 = require("ws");
const dotenv_1 = __importDefault(require("dotenv"));
const functionHandlers_1 = __importDefault(require("./functionHandlers"));
const CallEventLog_1 = require("./models/CallEventLog");
dotenv_1.default.config();
let session = {};
const agentConfigCache = new Map();
const AGENT_CONFIG_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
function invalidateAgentConfig(agentCode, customerId) {
    if (customerId) {
        const key = `${customerId}:${agentCode}`;
        agentConfigCache.delete(key);
        console.log("[CACHE] Invalidated agent config", { customerId, agentCode });
        return;
    }
    // If customerId not provided, clear all entries for this agentCode
    let removed = 0;
    for (const key of agentConfigCache.keys()) {
        if (key.endsWith(`:${agentCode}`)) {
            agentConfigCache.delete(key);
            removed++;
        }
    }
    console.log("[CACHE] Invalidated agent config by agentCode", {
        agentCode,
        removed,
    });
}
function handleCallConnection(ws, openAIApiKey) {
    cleanupConnection(session.twilioConn);
    session.twilioConn = ws;
    session.openAIApiKey = openAIApiKey;
    console.log("[CALL] New Twilio call WebSocket connected");
    ws.on("message", handleTwilioMessage);
    ws.on("error", (err) => {
        console.error("[CALL] Twilio WebSocket error", err);
        ws.close();
    });
    ws.on("close", () => {
        console.log("[CALL] Twilio call WebSocket closed");
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
    console.log("[FRONTEND] Logs WebSocket connected");
    ws.on("message", handleFrontendMessage);
    ws.on("close", () => {
        console.log("[FRONTEND] Logs WebSocket closed");
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
    var _a, _b;
    const msg = parseMessage(data);
    if (!msg)
        return;
    if (msg.event === 'start' || msg.event === 'close')
        // Persist raw Twilio event for auditing/analytics
        CallEventLog_1.CallEventLog.create(Object.assign({}, msg)).catch((err) => {
            console.error("[DB] Failed to persist CallEventLog (Twilio)", err);
        });
    switch (msg.event) {
        case "start":
            console.log("[CALL] Twilio stream started", msg, (_a = msg.start) === null || _a === void 0 ? void 0 : _a.streamSid);
            session.streamSid = msg.start.streamSid;
            session.latestMediaTimestamp = 0;
            session.lastAssistantItem = undefined;
            session.responseStartTimestamp = undefined;
            tryConnectModel((_b = msg.start) === null || _b === void 0 ? void 0 : _b.customParameters);
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
            console.log("[CALL] Twilio stream close event received");
            closeAllConnections();
            break;
    }
}
function handleFrontendMessage(data) {
    const msg = parseMessage(data);
    if (!msg)
        return;
    // Persist frontend session/update events as call event logs as well
    CallEventLog_1.CallEventLog.create(Object.assign({}, msg)).catch((err) => {
        console.error("[DB] Failed to persist CallEventLog (Frontend)", err);
    });
    if (isOpen(session.modelConn)) {
        jsonSend(session.modelConn, msg);
    }
    if (msg.type === "session.update") {
        console.log("[FRONTEND] session.update received from UI");
        session.saved_config = msg.session;
    }
}
function tryConnectModel(parameters) {
    if (!session.twilioConn || !session.streamSid || !session.openAIApiKey)
        return;
    if (isOpen(session.modelConn))
        return;
    console.log("[MODEL] Connecting to OpenAI realtime", {
        hasApiKey: !!session.openAIApiKey,
        streamSid: session.streamSid,
    });
    session.modelConn = new ws_1.WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
        headers: {
            Authorization: `Bearer ${session.openAIApiKey}`,
            "OpenAI-Beta": "realtime=v1",
        },
    });
    session.modelConn.on("open", () => __awaiter(this, void 0, void 0, function* () {
        console.log("[MODEL] OpenAI realtime WebSocket opened");
        const config = session.saved_config || {};
        const remoteConfig = yield fetchRemoteAgentConfig(parameters === null || parameters === void 0 ? void 0 : parameters.code, parameters === null || parameters === void 0 ? void 0 : parameters.customer, parameters === null || parameters === void 0 ? void 0 : parameters.session_id);
        // const remoteConfig:any = {};
        const instructions = remoteConfig.instructions ||
            process.env.AGENT_SYSTEM_PROMPT ||
            "Your Name is john. You are a realtime voice assistant with tool and memory access.Always speak in Hindi and Proactively use available tools (including vector memory search and storage) to help the user. Keep responses concise, speak naturally, and retrieve relevant memories before answering complex or contextual questions. When you call store_memory or search_memory, always pass client_id and agent_id so that memories are partitioned and retrieved per client and agent persona.";
        const voice = /*remoteConfig.voice  ||*/ "ash";
        const clientId = remoteConfig.client_id || config.client_id || "client-1";
        const agentId = remoteConfig.agent_id || config.agent_id || "sales_agent";
        console.log("[MODEL] Session config", {
            voice,
            clientId,
            agentId,
            instructionsSnippet: instructions.slice(0, 120),
        });
        jsonSend(session.modelConn, {
            type: "session.update",
            session: Object.assign({ modalities: ["text", "audio"], turn_detection: { type: "server_vad" }, voice, input_audio_transcription: { model: "whisper-1" }, input_audio_format: "g711_ulaw", output_audio_format: "g711_ulaw", instructions, tools: functionHandlers_1.default.map((f) => f.schema) }, config)
        });
        // jsonSend(session.modelConn, {
        //   type: "session.update",
        //   session: {
        //     modalities: ["text", "audio"],
        //     turn_detection: { type: "server_vad" },
        //     voice: "ash",
        //     input_audio_transcription: { model: "whisper-1" },
        //     input_audio_format: "g711_ulaw",
        //     output_audio_format: "g711_ulaw",
        //     instructions,
        //     ...config,
        //   },
        // });
    }));
    session.modelConn.on("message", handleModelMessage);
    session.modelConn.on("error", (err) => {
        console.error("[MODEL] Error on OpenAI realtime WebSocket", err);
        closeModel(err);
    });
    session.modelConn.on("close", (code, reason) => {
        console.log("[MODEL] OpenAI realtime WebSocket closed", { code, reason: reason.toString() });
        closeModel(undefined);
    });
}
function handleModelMessage(data) {
    const event = parseMessage(data);
    if (!event)
        return;
    // Forward all model events to frontend logs connection
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
                console.log("[MODEL] Function call received", item.name);
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
                        if (item.name === "end_call") {
                            console.log("[CALL] end_call tool invoked, closing all connections");
                            closeAllConnections();
                        }
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
function closeModel(err) {
    if (err) {
        console.error("[MODEL] Error in model connection", err);
    }
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
function fetchRemoteAgentConfig(agentCode, customerId, sessionId) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
        const cacheKey = `${customerId}:${agentCode}`;
        const cached = agentConfigCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < AGENT_CONFIG_TTL_MS) {
            return cached.config;
        }
        let remoteConfig = {};
        try {
            const response = yield fetch(`https://api-acharya.revoft.com/acharya/engine/v1/${"customerId"}/tenants/1/agent/${agentCode}/config`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${process.env.ACHARYA_API_KEY}`,
                },
            });
            if (response.ok) {
                const json = yield response.json();
                const data = (json === null || json === void 0 ? void 0 : json.data) || {};
                // agentSystemPrompt / fullConfig.context.systemPrompt come back as quoted strings
                const rawPrompt = data.agentSystemPrompt || ((_b = (_a = data.fullConfig) === null || _a === void 0 ? void 0 : _a.context) === null || _b === void 0 ? void 0 : _b.systemPrompt);
                let instructions = rawPrompt;
                if (typeof instructions === "string") {
                    // strip leading/trailing quotes if present
                    instructions = instructions.replace(/^\"|\"$/g, "");
                    instructions = instructions.replace("Aisha", (_c = data.fullConfig) === null || _c === void 0 ? void 0 : _c.personality);
                    // instructions = instructions.replace("${agentName}", data.fullConfig?.personality+ " who speaks in "+data.fullConfig?.language+` and clientID is ${customerId},agentID is ${agentCode}.`);
                    instructions = `clientID is ${customerId},agentID is ${agentCode}. ${instructions}`;
                }
                remoteConfig = {
                    instructions,
                    voice: data.voice || ((_e = (_d = data.fullConfig) === null || _d === void 0 ? void 0 : _d.context) === null || _e === void 0 ? void 0 : _e.voice),
                    client_id: data.clientId || ((_g = (_f = data.fullConfig) === null || _f === void 0 ? void 0 : _f.context) === null || _g === void 0 ? void 0 : _g.clientId),
                    agent_id: data.agentId || ((_j = (_h = data.fullConfig) === null || _h === void 0 ? void 0 : _h.context) === null || _j === void 0 ? void 0 : _j.agentId),
                };
                // Try to capture a version marker from Acharya payload if present
                const version = data.version ||
                    ((_k = data.fullConfig) === null || _k === void 0 ? void 0 : _k.version) ||
                    ((_m = (_l = data.fullConfig) === null || _l === void 0 ? void 0 : _l.context) === null || _m === void 0 ? void 0 : _m.version);
                agentConfigCache.set(cacheKey, {
                    config: remoteConfig,
                    fetchedAt: Date.now(),
                    version,
                });
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
