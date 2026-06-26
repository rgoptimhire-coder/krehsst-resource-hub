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

  const systemInstruction = `You are the KREHSST Resource Hub Assistant, a professional and supportive HR Copilot.

STRICT OUTPUT RULES — APPLY TO EVERY RESPONSE:
1. ZERO special characters. No asterisks, no underscores, no hashes, no backticks, no angle brackets, no bullet symbols. None at all.
2. Use only plain English text. For lists, start each item on a new line with a number and a dot (1. 2. 3.) or a plain hyphen followed by a space (- item). Nothing else.
3. Use CAPITAL LETTERS for section headers. No other styling.
4. Never copy-paste raw document text. Always rewrite in your own words.
5. Keep language clear, professional, and conversational.`;

  const hasContext = companyKnowledgeContext && companyKnowledgeContext.trim().length > 0;

  // Detect if user is explicitly asking for full details, a complete list, or a full document
  const detailKeywords = [
    "full", "complete", "all", "detailed", "detail", "every", "entire",
    "give me", "show me", "list all", "provide all", "generate", "create",
    "draft", "template", "sop", "job description", "jd", "screening questions",
    "interview questions", "20", "25", "all questions"
  ];
  const wantsFullDetail = detailKeywords.some((kw) =>
    userMessage.toLowerCase().includes(kw)
  );

  let prompt;

  if (hasContext) {
    if (wantsFullDetail) {
      prompt = `INTERNAL COMPANY DOCUMENTS:
${companyKnowledgeContext}

USER REQUEST: "${userMessage}"

The user has asked for full or detailed information. Using ONLY the internal documents above:

1. Start with: SOURCE: [document title]
2. Provide a thorough, complete answer covering all relevant points from the document.
3. Organize under CAPITAL LETTER section headers if needed.
4. Use plain hyphens for list items. No special characters whatsoever.
5. Do not truncate or summarize. Give everything relevant from the document.`;
    } else {
      prompt = `INTERNAL COMPANY DOCUMENTS:
${companyKnowledgeContext}

USER QUERY: "${userMessage}"

Using ONLY the internal documents above, give a SHORT SUMMARY answer:

1. Start with: SOURCE: [document title]
2. Summarize the key answer in 3 to 6 plain sentences or a short list of the most important points.
3. End with: "For full details, ask me to show the complete policy."
4. Use plain hyphens for list items. No special characters whatsoever.
5. Do not dump the full document. Keep it brief and useful.`;
    }
  } else {
    prompt = `USER QUERY: "${userMessage}"

No matching internal company document was found.

Start your response with exactly this line:
Data not available in Library, check alternate source below.

Then on the next line write:
SUGGESTED EXTERNAL GUIDANCE:

Then provide a COMPLETE and DETAILED answer using your broad HR expertise:
- If the user asks for screening questions, interview questions, job descriptions, policies, SOPs, or templates: generate the FULL document. Do not abbreviate. Do not stop early.
- For executive-level roles like CFO: provide at least 20 to 25 questions grouped by category such as Leadership, Finance, Compliance, Strategic Planning, Stakeholder Management, Team Management, Capital Allocation, and Risk Management.
- Organize with CAPITAL LETTER section headers.
- Use plain numbered lists (1. 2. 3.) or hyphens (- item) for all list items.
- No special characters, no asterisks, no markdown symbols of any kind.
- Write complete sentences and full content. Never say "and so on" or "etc."`;
  }

  const reply = await callGemini(prompt, systemInstruction);

  if (reply) return reply;

  return `Data not available in Library, check alternate source below.

SUGGESTED EXTERNAL GUIDANCE:
The system encountered a temporary issue. Please rephrase your question or contact HR management directly.`;
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
        "Data not available in Library, check alternate source below.\n\nSUGGESTED EXTERNAL GUIDANCE:\nSystem is recovering. Please resend your message in a moment.",
    });
  }
}
