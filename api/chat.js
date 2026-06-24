import { GoogleGenerativeAI } from "@google/generative-ai";

// Ensure API keys are present
if (!process.env.GEMINI_API_KEY || !process.env.NOTION_API_KEY) {
  console.error("CRITICAL: API Keys missing in environment variables.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const NOTION_VERSION = "2022-06-28";

// --- Helper Functions (keep existing logic) ---
function getPlainText(richText = []) { return richText.map(t => t.plain_text || "").join(""); }

function blockToText(block) {
  const type = block.type;
  const data = block[type];
  if (!data) return "";
  if (data.rich_text) return getPlainText(data.rich_text);
  if (type === "child_page") return data.title || "";
  return "";
}

function getPageTitle(page) {
  if (!page.properties) return "Untitled";
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && prop.title?.length) return getPlainText(prop.title);
  }
  return "Untitled";
}

async function getBlockChildren(blockId) {
  const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
  url.searchParams.set("page_size", "100");
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${process.env.NOTION_API_KEY}`, "Notion-Version": NOTION_VERSION }
  });
  const data = await response.json();
  return data.results || [];
}

async function searchNotionDocuments(query) {
  const response = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, page_size: 3, filter: { property: "object", value: "page" } })
  });
  const data = await response.json();
  if (!data.results) return [];
  
  return Promise.all(data.results.map(async (page) => ({
    title: getPageTitle(page),
    content: (await getBlockChildren(page.id)).map(blockToText).join("\n")
  })));
}

// --- Updated Core Logic ---
async function askGemini(userMessage, companyKnowledgeContext) {
  const systemInstruction = "You are the KREHSST Resource Hub Assistant. Provide concise, plain-text answers based on the context. No markdown, no bolding, max 250 words.";
  
  // FIXED: Using valid production model names
  const modelsToTry = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"];
  
  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
      const prompt = `Context: ${companyKnowledgeContext}\n\nQuery: ${userMessage}`;
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (e) {
      console.warn(`Model ${modelName} failed: ${e.message}`);
    }
  }
  throw new Error("All AI models failed.");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  
  try {
    const { message } = req.body;
    const docs = await searchNotionDocuments(message);
    const context = docs.map(d => `${d.title}: ${d.content}`).join("\n\n");
    
    const answer = await askGemini(message, context);
    return res.status(200).json({ answer });
  } catch (error) {
    console.error("LOGGING ERROR:", error);
    // Returning the actual error helps you debug via browser Network tab
    return res.status(500).json({ answer: `System Error: ${error.message}` });
  }
}
