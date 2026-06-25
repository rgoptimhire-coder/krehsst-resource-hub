import { GoogleGenerativeAI } from "@google/generative-ai";

// Ensure your environment variable matches exactly what is in your hosting platform (Vercel/Render)
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
    console.error("Notion Search Error:", err.message);
    return [];
  }
}

async function askGemini(userMessage, companyKnowledgeContext) {
  // Fast conversational greeting check
  const cleanMsg = userMessage.toLowerCase().trim();
  const greetings = ["hello", "hi", "hey", "good morning", "good afternoon", "sup", "yo", "test"];
  
  if (greetings.includes(cleanMsg) || cleanMsg.length <= 3) {
    return "Hello! 👋 I am your KREHSST Resource Hub Assistant. How can I help you with our company policies, guidelines, or resource documents today?";
  }

  const systemInstruction = `
    You are the KREHSST Resource Hub Assistant, a professional, supportive HR Copilot. Your goal is to guide employees accurately using the internal company context provided.

    CRITICAL CLEAN-OUTPUT INSTRUCTIONS:
    1. NO RAW MARKDOWN SYMBOLS: Do not use asterisks (*), underscores (_), or hashes (#) for bolding or bullet points. This avoids layout breakages on the client-side UI.
    2. CLEAN FORMATTING: Use plain text, emojis, capital letters for headers, and standard hyphens (-) for lists to keep the text visually clean and easy to read.
    3. NEVER COPY-PASTE RAW TEXT: Do not dump blocks of policy text. Synthesize and summarize clearly.
    4. EVALUATE RELEVANCE FIRST: Look at the PROVIDED COMPANY CONTEXT FROM NOTION. If it contains data but doesn't actually answer the user's specific request (e.g., user asks for a PMM Job Description but context only has recruiting strategies), treat the context as empty.
    5. WORD LIMIT: Keep your total response under 250 words.

    OUTPUT FORMAT CONDITIONS:

    [CONDITION A: IF RELEVANT DETAILS ARE FOUND IN THE NOTION CONTEXT]
    SOURCE DOCUMENT: [Insert Title Here]

    SUMMARY:
    - Clear bullet points translating the rule or policy simply.

    ADDITIONAL GUIDANCE: (Optional)
    - Provide practical industry tips if the policy leaves room for interpretation.

    [CONDITION B: IF DETAILS ARE NOT FOUND / CONTEXT IS EMPTY OR IRRELEVANT]
    Data not available in Library, check alternate source below.
    
    SUGGESTED EXTERNAL GUIDANCE:
    - Act as an expert HR Copilot and use your broad internet-trained knowledge to fulfill their request directly here.
    - Provide an exceptionally structured, helpful draft, template, or answer using plain text and clear hyphenated lists.
  `;

  const prompt = `
    PROVIDED COMPANY CONTEXT FROM NOTION:
    ${companyKnowledgeContext || "No internal documents matched this query."}

    USER QUERY:
    "${userMessage}"
  `;

  // Backend cascade loop starting directly with Gemini 3+ endpoints
  const modelsToTry = [
    "gemini-3.5-flash",
    "gemini-3.1-pro",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash"
  ];
  
  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: systemInstruction,
        generationConfig: { maxOutputTokens: 600, temperature: 0.3 } 
      });
      
      const reply = result?.response?.text();
      if (reply && reply.trim().length > 0) {
        return reply;
      }
    } catch (error) {
      console.warn(`Model ${modelName} error or rate limit. Trying next model tier...`, error.message);
      continue; 
    }
  }

  return `Data not available in Library, check alternate source below.\n\nSUGGESTED EXTERNAL GUIDANCE:\n- Connection timeout. Please rephrase your query or contact HR management.`;
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

    // Queries internal Notion database first
    const docs = await searchNotionDocuments(message);
    const companyKnowledgeContext = docs.length > 0 
      ? docs.map(doc => `DOCUMENT TITLE: ${doc.title}\nCONTENT:\n${doc.content}`).join("\n\n").substring(0, 10000)
      : "";

    // Executes cascading LLM pipeline
    const answer = await askGemini(message, companyKnowledgeContext);
    return res.status(200).json({ answer });

  } catch (error) {
    console.error("Critical System Catch:", error.message);
    return res.status(200).json({ 
      answer: "Data not available in Library, check alternate source below.\n\nSUGGESTED EXTERNAL GUIDANCE:\n- System infrastructure is recovering. Please resend your text in a brief moment." 
    });
  }
}
