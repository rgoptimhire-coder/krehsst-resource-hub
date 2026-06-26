import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const NOTION_VERSION = "2022-06-28";

// ─────────────────────────────────────────────
// NOTION UTILITIES
// ─────────────────────────────────────────────

function getPlainText(richText = []) {
  return richText.map((t) => t.plain_text || "").join("");
}

/**
 * Converts a Notion block to plain text.
 * Supports: paragraph, headings, lists, to_do, toggle, quote, callout, child_page.
 */
function blockToText(block) {
  const type = block.type;
  const data = block[type];
  if (!data) return "";

  const RICH_TEXT_TYPES = [
    "paragraph",
    "heading_1",
    "heading_2",
    "heading_3",
    "bulleted_list_item",
    "numbered_list_item",
    "to_do",
    "toggle",
    "quote",
    "callout",
  ];

  if (RICH_TEXT_TYPES.includes(type) && data.rich_text) {
    const prefix =
      type === "bulleted_list_item"
        ? "- "
        : type === "numbered_list_item"
        ? "• "
        : type === "to_do"
        ? (data.checked ? "[x] " : "[ ] ")
        : type === "heading_1"
        ? "# "
        : type === "heading_2"
        ? "## "
        : type === "heading_3"
        ? "### "
        : "";
    return prefix + getPlainText(data.rich_text);
  }

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
    const url = new URL(
      `https://api.notion.com/v1/blocks/${blockId}/children`
    );
    url.searchParams.set("page_size", "100");
    if (cursor) url.searchParams.set("start_cursor", cursor);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
      },
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

/**
 * Searches Notion for pages matching the query.
 * Returns up to 10 results with title + content (each capped at 1500 chars).
 */
async function searchNotionDocuments(query) {
  try {
    const response = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        page_size: 10,
        filter: { property: "object", value: "page" },
      }),
    });

    const data = await response.json();
    if (!response.ok || !data.results?.length) return [];

    const docs = [];
    for (const page of data.results) {
      const title = getPageTitle(page);
      const rawContent = await readPageContent(page.id);
      // Cap each document at 1500 chars so context stays manageable
      const content = rawContent.substring(0, 1500);
      docs.push({ title, content });
    }
    return docs;
  } catch (err) {
    console.error("Notion Search Error:", err.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// GEMINI UTILITIES
// ─────────────────────────────────────────────

const MODELS = ["gemini-2.5-flash", "gemini-2.5-pro"];

async function callGemini(prompt, systemInstruction) {
  for (const modelName of MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        systemInstruction,
        generationConfig: {
          maxOutputTokens: 4096,
          temperature: 0.3,
        },
      });
      const reply = result?.response?.text();
      if (reply && reply.trim().length > 0) return reply;
    } catch (error) {
      console.warn(`Model ${modelName} failed:`, error.message);
    }
  }
  return null;
}

/**
 * Uses Gemini to check if any retrieved docs actually answer the user's query.
 * Returns true if relevant, false otherwise.
 */
async function isContextRelevant(userMessage, docsContext) {
  const relevancePrompt = `User Query: "${userMessage}"

Documents:
${docsContext}

Do any of these documents contain information that DIRECTLY answers the user's query?
Reply with only YES or NO. Nothing else.`;

  const reply = await callGemini(relevancePrompt, "You are a relevance classifier. Reply only YES or NO.");
  return reply?.trim().toUpperCase().startsWith("YES") ?? false;
}

/**
 * Main Gemini call that generates the final HR assistant answer.
 */
async function askGemini(userMessage, companyKnowledgeContext) {
  // Fast greeting shortcut
  const cleanMsg = userMessage.toLowerCase().trim();
  const greetings = ["hello", "hi", "hey", "good morning", "good afternoon", "sup", "yo", "test"];
  if (greetings.includes(cleanMsg) || cleanMsg.length <= 3) {
    return "Hello! 👋 I am your KREHSST Resource Hub Assistant. How can I help you with company policies, guidelines, or HR resource documents today?";
  }

  const systemInstruction = `You are the KREHSST Resource Hub Assistant — a professional, supportive HR Copilot.

CRITICAL FORMATTING RULES:
1. NO raw Markdown symbols (no *, _, #). Use plain text, emojis, CAPITAL LETTERS for headers, and hyphens (-) for lists.
2. NEVER dump raw blocks of policy text. Synthesize and summarize clearly.
3. Keep responses focused and structured.
4. For document requests (Screening Questions, Interview Questions, Job Descriptions, Policies, SOPs, Templates): Generate the COMPLETE document — never stop midway, never summarize. Always provide every section in full.

WORD LIMIT: 800 words maximum unless the user explicitly requests a full document template, in which case provide everything completely.`;

  const hasContext = companyKnowledgeContext && companyKnowledgeContext.trim().length > 0;

  let prompt;

  if (hasContext) {
    prompt = `PROVIDED COMPANY CONTEXT FROM NOTION:
${companyKnowledgeContext}

USER QUERY: "${userMessage}"

INSTRUCTIONS:
Step 1 — The context above has already been verified as relevant to this query.
Step 2 — Use ONLY the internal context to answer. Begin your response with:

SOURCE DOCUMENT: [Insert the document title(s) from the context]

SUMMARY:
- Summarize the key points clearly using plain text and hyphens for lists.

ADDITIONAL GUIDANCE:
- If the policy has room for interpretation, add practical industry tips.`;
  } else {
    prompt = `USER QUERY: "${userMessage}"

No relevant internal company documents were found for this query.

INSTRUCTIONS:
- Begin your response EXACTLY with:

Data not available in Library, check alternate source below.

SUGGESTED EXTERNAL GUIDANCE:

- Then act as an expert HR Copilot and provide a COMPLETE, well-structured answer using your broad HR knowledge.
- If the user asks for Screening Questions, Job Descriptions, Interview Questions, Policies, SOPs, or Templates: Generate the FULL document with ALL sections. Do not abbreviate. Do not stop early. Do not say "and so on" or "etc."
- Use plain text with CAPITAL HEADERS and hyphens (-) for lists.
- For CFO or executive-level screening questions: provide at least 20-25 questions organized by category (Leadership, Finance, Compliance, Strategic Planning, Stakeholder Management, Team Management, Capital Allocation, Risk Management).`;
  }

  const reply = await callGemini(prompt, systemInstruction);

  if (reply) return reply;

  return `Data not available in Library, check alternate source below.

SUGGESTED EXTERNAL GUIDANCE:
- The system encountered a temporary issue. Please rephrase your question or contact HR management directly.`;
}

// ─────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ answer: "Only POST requests are allowed." });
    }

    const { message } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ answer: "Please enter a question." });
    }

    // Step 1: Search Notion
    const docs = await searchNotionDocuments(message);
    console.log("DOCUMENTS FOUND:", docs.length);

    // Step 2: Build raw context string
    const rawContext = docs
      .slice(0, 5)
      .map((doc) => `DOCUMENT TITLE: ${doc.title}\nCONTENT:\n${doc.content}`)
      .join("\n\n");

    // Step 3: Relevance check — only if we actually got documents
    let companyKnowledgeContext = "";
    if (docs.length > 0) {
      const relevant = await isContextRelevant(message, rawContext);
      console.log("CONTEXT RELEVANT:", relevant);
      if (relevant) {
        companyKnowledgeContext = rawContext;
      }
    }

    // Step 4: Generate final answer
    const answer = await askGemini(message, companyKnowledgeContext);
    console.log("ANSWER LENGTH:", answer.length);

    return res.status(200).json({ answer });
  } catch (error) {
    console.error("Critical System Catch:", error.message);
    return res.status(200).json({
      answer:
        "Data not available in Library, check alternate source below.\n\nSUGGESTED EXTERNAL GUIDANCE:\n- System is recovering. Please resend your message in a moment.",
    });
  }
}
