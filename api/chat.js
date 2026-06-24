import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const NOTION_VERSION = "2022-06-28";

function getPlainText(richText = []) {
  return richText.map(t => t.plain_text || "").join("");
}

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
    if (prop.type === "title" && prop.title?.length) {
      return getPlainText(prop.title);
    }
  }
  return "Untitled";
}

async function getBlockChildren(blockId) {
  let allBlocks = [];
  let cursor;

  do {
    const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
    url.searchParams.set("page_size", "100");
    if (cursor) url.searchParams.set("start_cursor", cursor);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION
      }
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Unable to read Notion content.");

    allBlocks.push(...(data.results || []));
    cursor = data.next_cursor;
  } while (cursor);

  return allBlocks;
}

async function readPageContent(pageId, depth = 0) {
  if (depth > 2) return "";
  const blocks = await getBlockChildren(pageId);
  let text = "";

  for (const block of blocks) {
    const blockText = blockToText(block);
    if (blockText) text += blockText + "\n";
    if (block.has_children) {
      text += await readPageContent(block.id, depth + 1);
    }
  }
  return text;
}

async function searchNotionDocuments(query) {
  const response = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      page_size: 5,
      filter: { property: "object", value: "page" }
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Notion search failed.");
  if (!data.results?.length) return [];

  const docs = [];
  for (const page of data.results) {
    const title = getPageTitle(page);
    const content = await readPageContent(page.id);
    docs.push({ title, url: page.url, content });
  }
  return docs;
}

// Helper utility to pause execution for retries
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Enhanced Gemini invocation utilizing Gemini 3.5 Flash and clean string text output
async function askGemini(userMessage, companyKnowledgeContext) {
  const model = genAI.getGenerativeModel({
    model: "gemini-3.5-flash", // Upgraded to Gemini 3.5 Flash
    systemInstruction: `
      You are the KREHSST Resource Hub Assistant, a professional, supportive HR Copilot. Your goal is to guide employees accurately using the internal company context provided.

      CRITICAL CLEAN-OUTPUT INSTRUCTIONS:
      1. NO RAW MARKDOWN SYMBOLS: Do not use asterisks (*), underscores (_), or hashes (#) for bolding or bullet points. This avoids layout breakages on the client-side UI.
      2. CLEAN FORMATTING: Use plain text, emojis, capital letters for headers, and standard hyphens (-) for lists to keep the text visually clean and easy to read.
      3. NEVER COPY-PASTE RAW TEXT: Do not dump blocks of policy text. Synthesize and summarize clearly.
      4. WORD LIMIT: Keep your total response under 250 words.

      OUTPUT FORMAT CONDITIONS:

      [IF KEY DETAILS ARE FOUND IN CONTEXT]
      SOURCE DOCUMENT: [Insert Title Here]

      SUMMARY:
      - Clear bullet points translating the rule or policy simply.

      ADDITIONAL GUIDANCE: (Optional)
      - Provide practical industry tips if the policy leaves room for interpretation.

      [IF DETAILS ARE NOT FOUND / CONTEXT IS EMPTY]
      No exact information was found in KREHSST internal documents.
      
      SUGGESTED EXTERNAL GUIDANCE:
      - Point 1
      - Point 2
      - Point 3
    `
  });

  const prompt = `
    PROVIDED COMPANY CONTEXT:
    ${companyKnowledgeContext || "No internal documents found for this query."}

    USER QUERY:
    "${userMessage}"
  `;

  const maxRetries = 3;
  let delay = 1500; 

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      const is503 = error.status === 503 || error.message?.includes("503") || error.message?.includes("demand");
      
      if (is503 && attempt < maxRetries) {
        console.warn(`Gemini 503 encountered. Retrying attempt ${attempt}/${maxRetries} after ${delay}ms...`);
        await sleep(delay);
        delay *= 2; 
        continue;
      }
      throw error;
    }
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ answer: "Only POST requests are allowed." });
    }

    const { message } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ answer: "Please enter a question." });
    }

    // Fetch context from Notion
    const docs = await searchNotionDocuments(message);

    // Format knowledge base block if documents exist
    const companyKnowledgeContext = docs.length > 0 
      ? docs.map(doc => `DOCUMENT TITLE: ${doc.title}\nCONTENT:\n${doc.content}`).join("\n\n").substring(0, 25000)
      : "";

    // Generate clean response using optimized logic
    const answer = await askGemini(message, companyKnowledgeContext);

    return res.status(200).json({ answer });

  } catch (error) {
    if (error.status === 503 || error.message?.includes("503") || error.message?.includes("demand")) {
      return res.status(200).json({
        answer: "The HR Copilot is experiencing an unusually high volume of requests at the moment. Please resubmit your question in a minute."
      });
    }

    return res.status(500).json({ answer: "Error: " + error.message });
  }
}
