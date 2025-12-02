import { RawData, WebSocket } from "ws";
import dotenv from "dotenv";
import functions from "./functionHandlers";
import { CallEventLog } from "./models/CallEventLog";

import Redis from "ioredis";

dotenv.config();

interface Session {
  twilioConn?: WebSocket;
  frontendConn?: WebSocket;
  modelConn?: WebSocket;
  streamSid?: string;
  saved_config?: any;
  lastAssistantItem?: string;
  responseStartTimestamp?: number;
  latestMediaTimestamp?: number;
  openAIApiKey?: string;
}

let session: Session = {};

type AgentConfigCacheEntry = { config: any; fetchedAt: number; version?: string };
const agentConfigCache = new Map<string, AgentConfigCacheEntry>();
const AGENT_CONFIG_TTL_MS = 24 * 60 * 60 * 1000;

const redisClient = new Redis({
  host: process.env.AZURE_REDIS_URL,
  port: 10000,
  password: process.env.AZURE_REDIS_PK,
  tls: {}  // TLS is required for Azure
});

redisClient.on("connect", () => {
  console.log("Connected to Azure Redis!");
});

redisClient.on("error", (err) => {
  console.error("Redis error:", err);
});

export function invalidateAgentConfig(agentCode: string, customerId?: string) {
  if (customerId) {
    const key = `${customerId}:${agentCode}`;
    agentConfigCache.delete(key);
    if (redisClient.status === "ready") {
      const redisKey = `agent-config:${key}`;
      redisClient.del(redisKey).catch((err:any) => {
        console.error("[REDIS] Failed to delete agent config key", { redisKey, err });
      });
    }
    console.log("[CACHE] Invalidated agent config", { customerId, agentCode });
    return;
  }

  // If customerId not provided, clear all entries for this agentCode
  let removed = 0;
  for (const key of agentConfigCache.keys()) {
    if (key.endsWith(`:${agentCode}`)) {
      agentConfigCache.delete(key);
      if (redisClient.status === "ready") {
        const redisKey = `agent-config:${key}`;
        redisClient.del(redisKey).catch((err:any) => {
          console.error("[REDIS] Failed to delete agent config key", { redisKey, err });
        });
      }
      removed++;
    }
  }
  console.log("[CACHE] Invalidated agent config by agentCode", {
    agentCode,
    removed,
  });
}

export function handleCallConnection(ws: WebSocket, openAIApiKey: string) {
  cleanupConnection(session.twilioConn);
  session.twilioConn = ws;
  session.openAIApiKey = openAIApiKey;
  console.log("[CALL] New Twilio call WebSocket connected");

  ws.on("message", handleTwilioMessage);
  ws.on("error", (err:any) => {
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
    if (!session.frontendConn) session = {};
  });
}

export function handleFrontendConnection(ws: WebSocket) {
  cleanupConnection(session.frontendConn);
  session.frontendConn = ws;
  console.log("[FRONTEND] Logs WebSocket connected");

  ws.on("message", handleFrontendMessage);
  ws.on("close", () => {
    console.log("[FRONTEND] Logs WebSocket closed");
    cleanupConnection(session.frontendConn);
    session.frontendConn = undefined;
    if (!session.twilioConn && !session.modelConn) session = {};
  });
}

async function handleFunctionCall(item: { name: string; arguments: string }) {
  console.log("Handling function call:", item);
  const fnDef = functions.find((f) => f.schema.name === item.name);
  if (!fnDef) {
    throw new Error(`No handler found for function: ${item.name}`);
  }

  let args: unknown;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    return JSON.stringify({
      error: "Invalid JSON arguments for function call.",
    });
  }

  try {
    console.log("Calling function:", fnDef.schema.name, args);
    const result = await fnDef.handler(args as any);
    return result;
  } catch (err: any) {
    console.error("Error running function:", err);
    return JSON.stringify({
      error: `Error running function ${item.name}: ${err.message}`,
    });
  }
}

function handleTwilioMessage(data: RawData) {
  const msg = parseMessage(data);
  if (!msg) return;
if(msg.event === 'start' || msg.event==='close')
  // Persist raw Twilio event for auditing/analytics
  CallEventLog.create({
    ...msg
    
  }).catch((err) => {
    console.error("[DB] Failed to persist CallEventLog (Twilio)", err);
  });

  switch (msg.event) {
    case "start":
      console.log("[CALL] Twilio stream started", msg,msg.start?.streamSid);
      session.streamSid = msg.start.streamSid;
      session.latestMediaTimestamp = 0;
      session.lastAssistantItem = undefined;
      session.responseStartTimestamp = undefined;
      tryConnectModel(msg.start?.customParameters);
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

function handleFrontendMessage(data: RawData) {
  const msg = parseMessage(data);
  if (!msg) return;

  // Persist frontend session/update events as call event logs as well
  CallEventLog.create({
    ...msg
  }).catch((err) => {
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

function tryConnectModel(parameters:any) {
  if (!session.twilioConn || !session.streamSid || !session.openAIApiKey)
    return;
  if (isOpen(session.modelConn)) return;
  console.log("[MODEL] Connecting to OpenAI realtime", {
    hasApiKey: !!session.openAIApiKey,
    streamSid: session.streamSid,
  });

  session.modelConn = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${session.openAIApiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  session.modelConn.on("open", async () => {
    console.log("[MODEL] OpenAI realtime WebSocket opened");
    const config = session.saved_config || {};
    const remoteConfig = await fetchRemoteAgentConfig(parameters?.code,parameters?.customer,parameters?.session_id);
    // const remoteConfig:any = {};

    const instructions =
      remoteConfig.instructions ||
      process.env.AGENT_SYSTEM_PROMPT ||
      "Your Name is john. You are a realtime voice assistant with tool and memory access.Always speak in Hindi and Proactively use available tools (including vector memory search and storage) to help the user. Keep responses concise, speak naturally, and retrieve relevant memories before answering complex or contextual questions. When you call store_memory or search_memory, always pass client_id and agent_id so that memories are partitioned and retrieved per client and agent persona.";

    const voice = /*remoteConfig.voice  ||*/"ash";
    const clientId = remoteConfig.client_id || (config as any).client_id || "client-1";
    const agentId =
      remoteConfig.agent_id || (config as any).agent_id || "sales_agent";

    console.log("[MODEL] Session config", {
      voice,
      clientId,
      agentId,
      instructionsSnippet: instructions.slice(0, 120),
    });

    jsonSend(session.modelConn, {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        turn_detection: { type: "server_vad" },
        voice,
        input_audio_transcription: { model: "whisper-1" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        instructions,
       
        tools: functions.map((f) => f.schema),
        ...config,
      }
    
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
  });

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

function handleModelMessage(data: RawData) {
  const event = parseMessage(data);
  if (!event) return;

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
        if (event.item_id) session.lastAssistantItem = event.item_id;

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
  if (
    !session.lastAssistantItem ||
    session.responseStartTimestamp === undefined
  )
    return;

  const elapsedMs =
    (session.latestMediaTimestamp || 0) - (session.responseStartTimestamp || 0);
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

function closeModel(err:any) {
  if (err) {
    console.error("[MODEL] Error in model connection", err);
  }
  cleanupConnection(session.modelConn);
  session.modelConn = undefined;
  if (!session.twilioConn && !session.frontendConn) session = {};
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

async function fetchRemoteAgentConfig(agentCode: string,customerId:string,sessionId:string): Promise<any> {
  const cacheKey = `${customerId}:${agentCode}`;
  const redisKey = `agent-config:${cacheKey}`;

  try {
    if (redisClient.status === "ready") {
      const cachedStr = await redisClient.get(redisKey);
      if (cachedStr) {
        const parsed = JSON.parse(cachedStr);
        return parsed;
      }
    }
  } catch (err) {
    console.error("[REDIS] Failed to read agent config from cache", { redisKey, err });
  }

  const cached = agentConfigCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < AGENT_CONFIG_TTL_MS) {
    return cached.config;
  }
  let remoteConfig: any = {};
  try {
    const response = await fetch(
      `https://api-acharya.revoft.com/acharya/engine/v1/${customerId}/tenants/1/agent/${agentCode}/config`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.ACHARYA_API_KEY}`,
        },
      }
    );
    if (response.ok) {
      const json = await response.json();
      const data = json?.data || {};

      // agentSystemPrompt / fullConfig.context.systemPrompt come back as quoted strings
      const rawPrompt =
        data.agentSystemPrompt || data.fullConfig?.context?.systemPrompt;
      let instructions = rawPrompt;
      if (typeof instructions === "string") {
        
        // strip leading/trailing quotes if present
        instructions = instructions.replace(/^\"|\"$/g, "");
        instructions = instructions.replace("Aisha",data.fullConfig?.personality)
        instructions = instructions.replace("{NAME}",data.fullConfig?.personality)
        instructions = instructions.replace("{GENDER}",data.fullConfig?.gender)
        instructions = instructions.replace("{TONE}",data.fullConfig?.tone)
        instructions = instructions.replace("{LANGUAGE}",data.fullConfig?.language)
        // instructions = instructions.replace("${agentName}", data.fullConfig?.personality+ " who speaks in "+data.fullConfig?.language+` and clientID is ${customerId},agentID is ${agentCode}.`);
     instructions = `clientID is ${customerId} which is company code and should not revealed any info related to it,agentID is ${agentCode} similarly agentID is confidential. ${instructions}`;
      }

      remoteConfig = {
        instructions,
        voice: data.voice || data.fullConfig?.context?.voice,
        client_id: data.clientId || data.fullConfig?.context?.clientId,
        agent_id: data.agentId || data.fullConfig?.context?.agentId,
      };

      // Try to capture a version marker from Acharya payload if present
      const version: string | undefined =
        (data as any).version ||
        (data.fullConfig as any)?.version ||
        (data.fullConfig as any)?.context?.version;

      const entry: AgentConfigCacheEntry = {
        config: remoteConfig,
        fetchedAt: Date.now(),
        version,
      };

      agentConfigCache.set(cacheKey, entry);

      if (redisClient.status === "ready") {
        try {
          await redisClient.set(
            redisKey,
            JSON.stringify(entry.config),
            "EX",
            AGENT_CONFIG_TTL_MS / 1000
          );
        } catch (err) {
          console.error("[REDIS] Failed to write agent config to cache", { redisKey, err });
        }
      }
    }
  } catch (err) {
    console.error("Failed to fetch remote agent config", err);
  }

  return remoteConfig || {};
}


async function fetchRemoteCustomerDetails(agentCode: string,customerId:string,sessionId:string): Promise<any> {
  const cacheKey = `${customerId}:${agentCode}`;
  const cached = agentConfigCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < AGENT_CONFIG_TTL_MS) {
    return cached.config;
  }
  let remoteConfig: any = {};
  try {
    const response = await fetch(
      `http://localhost:3001/v1/crm/customer/${customerId}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.ACHARYA_API_KEY}`,
        },
      }
    );
    if (response.ok) {
      const json = await response.json();
      const data = json?.data || {};

      // agentSystemPrompt / fullConfig.context.systemPrompt come back as quoted strings
      const rawPrompt =
        data.agentSystemPrompt || data.fullConfig?.context?.systemPrompt;
      let instructions = rawPrompt;
      if (typeof instructions === "string") {
        // strip leading/trailing quotes if present
        instructions = instructions.replace(/^\"|\"$/g, "");
        instructions = instructions.replace("Aisha",data.fullConfig?.personality)
        // instructions = instructions.replace("${agentName}", data.fullConfig?.personality+ " who speaks in "+data.fullConfig?.language+` and clientID is ${customerId},agentID is ${agentCode}.`);
     instructions = `clientID is ${customerId},agentID is ${agentCode}. ${instructions}`;
      }

      remoteConfig = {
        instructions,
        voice: data.voice || data.fullConfig?.context?.voice,
        client_id: data.clientId || data.fullConfig?.context?.clientId,
        agent_id: data.agentId || data.fullConfig?.context?.agentId,
      };

      // Try to capture a version marker from Acharya payload if present
      const version: string | undefined =
        (data as any).version ||
        (data.fullConfig as any)?.version ||
        (data.fullConfig as any)?.context?.version;

      agentConfigCache.set(cacheKey, {
        config: remoteConfig,
        fetchedAt: Date.now(),
        version,
      });
    }
  } catch (err) {
    console.error("Failed to fetch remote agent config", err);
  }

  return remoteConfig || {};
}


function cleanupConnection(ws?: WebSocket) {
  if (isOpen(ws)) ws.close();
}

function parseMessage(data: RawData): any {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}

function jsonSend(ws: WebSocket | undefined, obj: unknown) {
  if (!isOpen(ws)) return;
  ws.send(JSON.stringify(obj));
}

function isOpen(ws?: WebSocket): ws is WebSocket {
  return !!ws && ws.readyState === WebSocket.OPEN;
}
