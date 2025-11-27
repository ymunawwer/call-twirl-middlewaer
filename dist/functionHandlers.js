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
Object.defineProperty(exports, "__esModule", { value: true });
const qdrantClient_1 = require("./qdrantClient");
const functions = [];
functions.push({
    schema: {
        name: "get_weather_from_coords",
        type: "function",
        description: "Get the current weather",
        parameters: {
            type: "object",
            properties: {
                latitude: {
                    type: "number",
                },
                longitude: {
                    type: "number",
                },
            },
            required: ["latitude", "longitude"],
        },
    },
    handler: (args) => __awaiter(void 0, void 0, void 0, function* () {
        var _a;
        const response = yield fetch(`https://api.open-meteo.com/v1/forecast?latitude=${args.latitude}&longitude=${args.longitude}&current=temperature_2m,wind_speed_10m&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m`);
        const data = yield response.json();
        const currentTemp = (_a = data.current) === null || _a === void 0 ? void 0 : _a.temperature_2m;
        return JSON.stringify({ temp: currentTemp });
    }),
});
functions.push({
    schema: {
        name: "store_memory",
        type: "function",
        description: "Store a piece of conversation or knowledge in vector memory (Qdrant). Use this for information that could be useful later.",
        parameters: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    description: "The text content to store in memory.",
                },
                metadata: {
                    type: "object",
                    description: "Optional JSON metadata about the memory (e.g. source, tags, role).",
                },
                client_id: {
                    type: "string",
                    description: "Logical client identifier. Use the same value across calls for the same end user.",
                },
                agent_id: {
                    type: "string",
                    description: "Identifier of the agent/persona that owns this memory (if you run multiple agents).",
                },
            },
            required: ["text"],
        },
    },
    handler: (args) => __awaiter(void 0, void 0, void 0, function* () {
        const result = yield (0, qdrantClient_1.storeMemory)({
            text: args.text,
            metadata: Object.assign(Object.assign(Object.assign({}, (args.metadata || {})), (args.client_id ? { client_id: args.client_id } : {})), (args.agent_id ? { agent_id: args.agent_id } : {})),
        });
        return JSON.stringify({ id: result.id });
    }),
});
functions.push({
    schema: {
        name: "search_memory",
        type: "function",
        description: "Search vector memory (Qdrant) for information relevant to the current query.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Natural language query describing what information to retrieve.",
                },
                top_k: {
                    type: "number",
                    description: "Maximum number of results to return (default 5).",
                },
                client_id: {
                    type: "string",
                    description: "If provided, restrict results to this client_id in memory payload.",
                },
                agent_id: {
                    type: "string",
                    description: "If provided, restrict results to this agent_id in memory payload.",
                },
            },
            required: ["query"],
        },
    },
    handler: (args) => __awaiter(void 0, void 0, void 0, function* () {
        const results = yield (0, qdrantClient_1.searchMemory)({
            query: args.query,
            top_k: args.top_k,
            client_id: args.client_id,
            agent_id: args.agent_id,
        });
        return JSON.stringify({ results });
    }),
});
exports.default = functions;
