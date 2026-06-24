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

// Optimized Gemini invocation utilizing modern System Instructions
async function askGemini(userMessage, companyKnowledgeContext) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: `
      You are the KREHSST Resource Hub Assistant, a professional, supportive HR Copilot. Your goal is to guide employees accurately using the internal company context provided.

      CRITICAL INSTRUCTIONS:
      1. PRIORITIZE PROVIDED CONTEXT: Always check the "PROVIDED COMPANY CONTEXT" section first. If the answer is there, use it.
      2. NEVER COPY-PASTE RAW TEXT: Do not dump blocks of policy text. Synthesize and summarize clearly.
      3. FALLBACK GRACEFULLY: If the provided context is empty, unrelated, or lacks the necessary details to fully answer the query, switch smoothly to professional HR/industry best practices.
      4. WORD LIMIT: Keep your total response under 250 words.

      OUTPUT FORMAT CONDITIONS:

      [IF KEY DETAILS ARE FOUND IN CONTEXT]
      📄 **Source Document:** [Insert Title Here]
      ✅ **Summary:**
      - Clear bullet points translating the rule or policy simply.
      💡 **Additional Guidance:** (Optional)
      - Provide practical industry tips if the policy leaves room for interpretation.

      [IF DETAILS ARE NOT FOUND / CONTEXT IS EMPTY]
      ⚠️ *No exact information was found in KREHSST internal documents.*
      
      💡 **Suggested External Guidance:**
      - Provide 2-3 clear industry standard best practice bullet points handling the user's situation.
    `
  });

  const prompt = `
    PROVIDED COMPANY CONTEXT:
    ${companyKnowledgeContext || "No internal documents found for this query."}

    USER QUERY:
    "${userMessage}"
  `;

  const result = await model.generateContent(prompt);
  return result.response.text();
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

    // Pull documents from Notion
    const docs = await searchNotionDocuments(message);

    // Format knowledge base block if documents exist
    const companyKnowledgeContext = docs.length > 0 
      ? docs.map(doc => `DOCUMENT TITLE: ${doc.title}\nCONTENT:\n${doc.content}`).join("\n\n").substring(0, 25000)
      : "";

    // Generate response using optimized assistant logic
    const answer = await askGemini(message, companyKnowledgeContext);

    return res.status(200).json({ answer });

  } catch (error) {
    return res.status(500).json({ answer: "Error: " + error.message });
  }
}
