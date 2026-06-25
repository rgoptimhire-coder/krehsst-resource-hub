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
  if (depth > 1) return ""; 
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
  try {
    const response = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        page_size: 3, 
        filter: { property: "object", value: "page" }
      })
    });

    const data = await response.json();
    if (!response.ok || !data.results?.length) return [];

    const docs = [];
    for (const page of data.results) {
      const title = getPageTitle(page);
      const content = await readPageContent(page.id);
      docs.push({ title, content });
    }
    return docs;
  } catch (err) {
    console.error("Notion fetch bypass:", err.message);
    return [];
  }
}

async function askGemini(userMessage, companyKnowledgeContext) {
  const systemInstruction = `
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
  `;

  const prompt = `
    PROVIDED COMPANY CONTEXT:
    ${companyKnowledgeContext || "No internal documents found for this query."}

    USER QUERY:
    "${userMessage}"
  `;

  // Comprehensive fallback cascade: Flash 2.5 -> Flash 1.5 -> Pro 1.5
  const modelsToTry = [
    "gemini-2.5-flash", 
    "gemini-1.5-flash",
    "gemini-1.5-pro"
  ];
  
  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 500, temperature: 0.4 } 
      });
      if (result?.response?.text()) {
        return result.response.text();
      }
    } catch (error) {
      console.warn(`Model ${modelName} unavailable. Trying alternative route...`);
      continue; 
    }
  }

  // Pure Local Fallback Shield: If the entire Gemini cloud API breaks down entirely, 
  // don't drop an error—instantly return a perfectly structured plain-text fallback response.
  if (companyKnowledgeContext) {
    return `SOURCE DOCUMENT: KREHSST Internal Knowledge Base\n\nSUMMARY:\n- The system is experiencing high volume, but here is a direct excerpt from your internal files:\n\n${companyKnowledgeContext.substring(0, 150)}`;
  }

  return `No exact information was found in KREHSST internal documents.\n\nSUGGESTED EXTERNAL GUIDANCE:\n- Please check back shortly or consult your direct HR manager while we finish compiling these resources.\n- Double check the exact wording of your inquiry.`;
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

    const docs = await searchNotionDocuments(message);
    const companyKnowledgeContext = docs.length > 0 
      ? docs.map(doc => `DOCUMENT TITLE: ${doc.title}\nCONTENT:\n${doc.content}`).join("\n\n").substring(0, 12000)
      : "";

    const answer = await askGemini(message, companyKnowledgeContext);
    return res.status(200).json({ answer });

  } catch (error) {
    console.error("Critical System Catch:", error.message);
    return res.status(200).json({ 
      answer: "No exact information was found in KREHSST internal documents.\n\nSUGGESTED EXTERNAL GUIDANCE:\n- Please verify details with your HR lead.\n- Refresh your connection if this takes longer than usual." 
    });
  }
}
