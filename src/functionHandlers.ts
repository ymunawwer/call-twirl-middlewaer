import { FunctionHandler } from "./types";
import {
  storeMemory,
  searchMemory,
  storeKnowledge,
  searchKnowledge,
} from "./qdrantClient";

const functions: FunctionHandler[] = [];

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
  handler: async (args: { latitude: number; longitude: number }) => {
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${args.latitude}&longitude=${args.longitude}&current=temperature_2m,wind_speed_10m&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m`
    );
    const data = await response.json();
    const currentTemp = data.current?.temperature_2m;
    return JSON.stringify({ temp: currentTemp });
  },
});

functions.push({
  schema: {
    name: "end_call",
    type: "function",
    description:
      "Signal that the current call should be disconnected. Use this when the user explicitly asks to end or hang up the call.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    // Actual hangup is triggered in sessionManager based on this tool name
    return JSON.stringify({ status: "ok" });
  },
});

functions.push({
  schema: {
    name: "store_memory",
    type: "function",
    description:
      "Store a piece of conversation or knowledge in vector memory (Qdrant). Use this for information that could be useful later.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text content to store in memory.",
        },
        metadata: {
          type: "object",
          description:
            "Optional JSON metadata about the memory (e.g. source, tags, role).",
        },
        client_id: {
          type: "string",
          description:
            "Logical client identifier. Use the same value across calls for the same end user.",
        },
        agent_id: {
          type: "string",
          description:
            "Identifier of the agent/persona that owns this memory (if you run multiple agents).",
        },
      },
      required: ["text"],
    },
  },
  handler: async (args: {
    text: string;
    metadata?: Record<string, any>;
    client_id?: string;
    agent_id?: string;
  }) => {
    console.log("[TOOL] store_memory called", {
      hasMetadata: !!args.metadata,
      client_id: args.client_id,
      agent_id: args.agent_id,
    });
    const result = await storeMemory({
      text: args.text,
      metadata: {
        ...(args.metadata || {}),
        ...(args.client_id ? { client_id: args.client_id } : {}),
        ...(args.agent_id ? { agent_id: args.agent_id } : {}),
      },
    });
    console.log("[TOOL] store_memory stored", { id: result.id });
    return JSON.stringify({ id: result.id });
  },
});

functions.push({
  schema: {
    name: "search_memory",
    type: "function",
    description:
      "Search vector memory (Qdrant) for information relevant to the current query.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language query describing what information to retrieve.",
        },
        top_k: {
          type: "number",
          description: "Maximum number of results to return (default 5).",
        },
        client_id: {
          type: "string",
          description:
            "If provided, restrict results to this client_id in memory payload.",
        },
        agent_id: {
          type: "string",
          description:
            "If provided, restrict results to this agent_id in memory payload.",
        },
      },
      required: ["query"],
    },
  },
  handler: async (args: {
    query: string;
    top_k?: number;
    client_id?: string;
    agent_id?: string;
  }) => {
    console.log("[TOOL] search_memory called", {
      query: args.query,
      top_k: args.top_k,
      client_id: args.client_id,
      agent_id: args.agent_id,
    });
    const results = await searchMemory({
      query: args.query,
      top_k: args.top_k,
      client_id: args.client_id,
      agent_id: args.agent_id,
    });
    console.log("[TOOL] search_memory results", { count: results.length });
    return JSON.stringify({ results });
  },
});

functions.push({
  schema: {
    name: "store_product_knowledge",
    type: "function",
    description:
      "Store structured product or company knowledge in a dedicated vector collection. Use this for static docs, FAQs, or policy text.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "The product/company knowledge text to store (e.g. feature description, policy, FAQ).",
        },
        metadata: {
          type: "object",
          description:
            "Optional JSON metadata (e.g. source, section, tags, language).",
        },
        product_id: {
          type: "string",
          description:
            "Optional product identifier this knowledge belongs to.",
        },
        company_id: {
          type: "string",
          description:
            "Optional company identifier this knowledge belongs to.",
        },
      },
      required: ["text"],
    },
  },
  handler: async (args: {
    text: string;
    metadata?: Record<string, any>;
    product_id?: string;
    company_id?: string;
  }) => {
    console.log("[TOOL] store_product_knowledge called", {
      hasMetadata: !!args.metadata,
      product_id: args.product_id,
      company_id: args.company_id,
    });
    const result = await storeKnowledge({
      text: args.text,
      metadata: {
        ...(args.metadata || {}),
        ...(args.product_id ? { product_id: args.product_id } : {}),
        ...(args.company_id ? { company_id: args.company_id } : {}),
      },
    });
    console.log("[TOOL] store_product_knowledge stored", { id: result.id });
    return JSON.stringify({ id: result.id });
  },
});

functions.push({
  schema: {
    name: "search_product_knowledge",
    type: "function",
    description:
      "Search product/company knowledge for information relevant to the current query.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language question or query about the product/company.",
        },
        top_k: {
          type: "number",
          description: "Maximum number of results to return (default 5).",
        },
        product_id: {
          type: "string",
          description:
            "If provided, restrict results to this product_id in payload.",
        },
        company_id: {
          type: "string",
          description:
            "If provided, restrict results to this company_id in payload.",
        },
      },
      required: ["query"],
    },
  },
  handler: async (args: {
    query: string;
    top_k?: number;
    product_id?: string;
    company_id?: string;
  }) => {
    console.log("[TOOL] search_product_knowledge called", {
      query: args.query,
      top_k: args.top_k,
      product_id: args.product_id,
      company_id: args.company_id,
    });
    const results = await searchKnowledge({
      query: args.query,
      top_k: args.top_k,
      product_id: args.product_id,
      company_id: args.company_id,
    });
    console.log("[TOOL] search_product_knowledge results", { count: results.length });
    return JSON.stringify({ results });
  },
});

export default functions;
