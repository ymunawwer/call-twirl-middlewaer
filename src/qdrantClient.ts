import dotenv from "dotenv";
import { randomUUID } from "crypto";
dotenv.config();

const QDRANT_URL = process.env.QDRANT_URL || "http://20.115.57.237:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || "";
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || "conversation_memory";
const QDRANT_KNOWLEDGE_COLLECTION =
  process.env.QDRANT_KNOWLEDGE_COLLECTION || "product_knowledge";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY environment variable is required for embeddings");
}

const VECTOR_SIZE = 1536;

async function qdrantRequest(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (QDRANT_API_KEY) {
    headers["api-key"] = QDRANT_API_KEY;
  }
  const url = `${QDRANT_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      ...(init.headers as any),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("[QDRANT] Request failed", { url, status: res.status, text });
    throw new Error(`Qdrant request failed: ${res.status}`);
  }
  return res.json();
}

async function ensureCollection() {
  await qdrantRequest(`/collections/${QDRANT_COLLECTION}`)
    .catch(async () => {
      console.log("[QDRANT] Creating collection", QDRANT_COLLECTION);
      await qdrantRequest(`/collections/${QDRANT_COLLECTION}`, {
        method: "PUT",
        body: JSON.stringify({
          vectors: {
            size: VECTOR_SIZE,
            distance: "Cosine",
          },
        }),
      });
    });
}

async function ensureKnowledgeCollection() {
  await qdrantRequest(`/collections/${QDRANT_KNOWLEDGE_COLLECTION}`)
    .catch(async () => {
      console.log("[QDRANT] Creating knowledge collection", QDRANT_KNOWLEDGE_COLLECTION);
      await qdrantRequest(`/collections/${QDRANT_KNOWLEDGE_COLLECTION}`, {
        method: "PUT",
        body: JSON.stringify({
          vectors: {
            size: VECTOR_SIZE,
            distance: "Cosine",
          },
        }),
      });
    });
}

async function embedText(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
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
    const text = await res.text();
    throw new Error(`OpenAI embeddings failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  const vector = data.data?.[0]?.embedding;
  if (!Array.isArray(vector)) {
    throw new Error("Invalid embedding response from OpenAI");
  }
  return vector;
}

export async function storeMemory(payload: {
  text: string;
  metadata?: Record<string, any>;
}) {
  await ensureCollection();
  const vector = await embedText(payload.text);
  const pointId = randomUUID();//`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body = {
    points: [
      {
        id: pointId,
        vector,
        payload: {
          text: payload.text,
          ...(payload.metadata || {}),
        },
      },
    ],
  };
  console.log("[QDRANT] storeMemory", {
    id: pointId,
    hasMetadata: !!payload.metadata,
  });
  await qdrantRequest(`/collections/${QDRANT_COLLECTION}/points`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return { id: pointId };
}

export async function searchMemory(payload: {
  query: string;
  top_k?: number;
  client_id?: string;
  agent_id?: string;
}) {
  await ensureCollection();
  const vector = await embedText(payload.query);
  const limit = payload.top_k || 5;
  const must: any[] = [];
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

  const body: any = {
    vector,
    limit,
    with_payload: true,
  };

  if (must.length > 0) {
    body.filter = { must };
  }
  console.log("[QDRANT] searchMemory", {
    top_k: limit,
    client_id: payload.client_id,
    agent_id: payload.agent_id,
  });
  const res = await qdrantRequest(`/collections/${QDRANT_COLLECTION}/points/search`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res?.result || [];
}

export async function storeKnowledge(payload: {
  text: string;
  metadata?: Record<string, any>;
}) {
  await ensureKnowledgeCollection();
  const vector = await embedText(payload.text);
  const pointId = randomUUID();
  const body = {
    points: [
      {
        id: pointId,
        vector,
        payload: {
          text: payload.text,
          ...(payload.metadata || {}),
        },
      },
    ],
  };
  console.log("[QDRANT] storeKnowledge", {
    id: pointId,
    hasMetadata: !!payload.metadata,
  });
  await qdrantRequest(`/collections/${QDRANT_KNOWLEDGE_COLLECTION}/points`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return { id: pointId };
}

export async function searchKnowledge(payload: {
  query: string;
  top_k?: number;
  product_id?: string;
  company_id?: string;
}) {
  await ensureKnowledgeCollection();
  const vector = await embedText(payload.query);
  const limit = payload.top_k || 5;

  const must: any[] = [];
  if (payload.product_id) {
    must.push({ key: "product_id", match: { value: payload.product_id } });
  }
  if (payload.company_id) {
    must.push({ key: "company_id", match: { value: payload.company_id } });
  }

  const body: any = {
    vector,
    limit,
    with_payload: true,
  };

  if (must.length > 0) {
    body.filter = { must };
  }

  console.log("[QDRANT] searchKnowledge", {
    top_k: limit,
    product_id: payload.product_id,
    company_id: payload.company_id,
  });
  const res = await qdrantRequest(
    `/collections/${QDRANT_KNOWLEDGE_COLLECTION}/points/search`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );
  return res?.result || [];
}
