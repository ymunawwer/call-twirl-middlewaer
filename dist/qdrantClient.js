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
exports.storeMemory = storeMemory;
exports.searchMemory = searchMemory;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || "";
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || "conversation_memory";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY environment variable is required for embeddings");
}
const VECTOR_SIZE = 1536;
function qdrantRequest(path_1) {
    return __awaiter(this, arguments, void 0, function* (path, init = {}) {
        const headers = {
            "Content-Type": "application/json",
        };
        if (QDRANT_API_KEY) {
            headers["api-key"] = QDRANT_API_KEY;
        }
        const res = yield fetch(`${QDRANT_URL}${path}`, Object.assign(Object.assign({}, init), { headers: Object.assign(Object.assign({}, headers), init.headers) }));
        if (!res.ok) {
            const text = yield res.text();
            throw new Error(`Qdrant request failed: ${res.status} ${text}`);
        }
        return res.json();
    });
}
function ensureCollection() {
    return __awaiter(this, void 0, void 0, function* () {
        yield qdrantRequest(`/collections/${QDRANT_COLLECTION}`)
            .catch(() => __awaiter(this, void 0, void 0, function* () {
            yield qdrantRequest(`/collections/${QDRANT_COLLECTION}`, {
                method: "PUT",
                body: JSON.stringify({
                    vectors: {
                        size: VECTOR_SIZE,
                        distance: "Cosine",
                    },
                }),
            });
        }));
    });
}
function embedText(text) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const res = yield fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
                input: text,
            }),
        });
        if (!res.ok) {
            const text = yield res.text();
            throw new Error(`OpenAI embeddings failed: ${res.status} ${text}`);
        }
        const data = yield res.json();
        const vector = (_b = (_a = data.data) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.embedding;
        if (!Array.isArray(vector)) {
            throw new Error("Invalid embedding response from OpenAI");
        }
        return vector;
    });
}
function storeMemory(payload) {
    return __awaiter(this, void 0, void 0, function* () {
        yield ensureCollection();
        const vector = yield embedText(payload.text);
        const pointId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const body = {
            points: [
                {
                    id: pointId,
                    vector,
                    payload: Object.assign({ text: payload.text }, (payload.metadata || {})),
                },
            ],
        };
        yield qdrantRequest(`/collections/${QDRANT_COLLECTION}/points`, {
            method: "PUT",
            body: JSON.stringify(body),
        });
        return { id: pointId };
    });
}
function searchMemory(payload) {
    return __awaiter(this, void 0, void 0, function* () {
        yield ensureCollection();
        const vector = yield embedText(payload.query);
        const limit = payload.top_k || 5;
        const must = [];
        if (payload.client_id) {
            must.push({
                key: "client_id",
                match: { value: payload.client_id },
            });
        }
        if (payload.agent_id) {
            must.push({
                key: "agent_id",
                match: { value: payload.agent_id },
            });
        }
        const body = {
            vector,
            limit,
            with_payload: true,
        };
        if (must.length > 0) {
            body.filter = { must };
        }
        const res = yield qdrantRequest(`/collections/${QDRANT_COLLECTION}/points/search`, {
            method: "POST",
            body: JSON.stringify(body),
        });
        return (res === null || res === void 0 ? void 0 : res.result) || [];
    });
}
