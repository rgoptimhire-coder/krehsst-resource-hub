import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const NOTION_VERSION = "2022-06-28";

const MODELS = [
  "gemini-3.1-pro",
  "gemini-3-flash",
  "gemini-2.5-pro"
];

// ─────────────────────────────────────────────
// NOTION UTILITIES
// ─────────────────────────────────────────────

function getPlainText(richText = []) {
  return richText.map((t) => t.plain_text || "").join("");
}

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
    "callout"
  ];

  if (RICH_TEXT_TYPES.includes(type) && data.rich_text) {
    const prefix =
      type === "bulleted_list_item"
        ? "- "
        : type === "numbered_list_item"
        ? "• "
        : type === "to_do"
        ? data.checked
          ? "[x] "
          : "[ ] "
        : type === "heading_1"
        ? "# "
        : type === "heading_2"
        ? "## "
        : type === "heading_3"
        ? "### "
        : "";

    return prefix + getPlainText(data.rich_text);
  }

  if (type === "child_page") {
    return data.title || "";
  }

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

    if (cursor) {
      url.searchParams.set("start_cursor", cursor);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION
      }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Unable to read Notion content.");
    }

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

    if (blockText) {
      text += blockText + "\n";
    }

    if (block.has_children) {
      text += await readPageContent(block.id, depth + 1);
    }
  }

  return text;
}

async function searchNotionDocuments(query) {
  try {
    const response = await fetch(
      "https://api.notion.com/v1/search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query,
          page_size: 10,
          filter: {
            property: "object",
            value: "page"
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("NOTION SEARCH ERROR:", data);
      return [];
    }

    if (!data.results?.length) {
      return [];
    }

    const docs = [];

    for (const page of data.results) {
      try {
        docs.push({
          title: getPageTitle(page),
          content: (
            await readPageContent(page.id)
          ).substring(0, 1500)
        });
      } catch (err) {
        console.error("PAGE READ ERROR:", err);
      }
    }

    return docs;
  } catch (err) {
    console.error("NOTION API ERROR:", err);
    return [];
  }
}

// ─────────────────────────────────────────────
// GEMINI UTILITIES
// ─────────────────────────────────────────────

async function callGemini(prompt, systemInstruction) {
  for (const modelName of MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName
      });

      const result = await model.generateContent({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        systemInstruction,
        generationConfig: {
          maxOutputTokens: 4096,
          temperature: 0.3
        }
      });

      const reply = result?.response?.text();

      if (reply?.trim()) {
        return reply;
      }
    } catch (error) {
      console.error(`MODEL FAILED: ${modelName}`, error);
    }
  }

  return null;
}

async function isContextRelevant(userMessage, docsContext) {
  const reply = await callGemini(
    `User Query: "${userMessage}"
Documents:
${docsContext}

Does this answer the query?

Reply only YES or NO.`,
    "Reply only YES or NO."
  );

  return reply?.trim().toUpperCase().startsWith("YES") ?? false;
}

async function askGemini(userMessage, companyKnowledgeContext) {
  const cleanMsg = userMessage.toLowerCase().trim();

  if (
    ["hi", "hello", "hey", "test"].includes(cleanMsg) ||
    cleanMsg.length <= 3
  ) {
    return "Hello. I am your KREHSST Resource Hub Assistant. How can I help you today?";
  }

  const systemInstruction =
    "You are a professional HR Copilot. RULES: 1. NO special characters. 2. Use plain text. 3. Use CAPITAL LETTERS for headers. 4. Use hyphens for lists. 5. Provide complete answers.";

  const hasContext =
    companyKnowledgeContext &&
    companyKnowledgeContext.trim().length > 0;

  const prompt = hasContext
    ? `CONTEXT:
${companyKnowledgeContext}

QUERY:
${userMessage}

Answer using the provided context. Start with SOURCE: [title].`
    : `QUERY:
${userMessage}

No internal documents found.

Start with:
Data not available in Library, check alternate source below.

Then provide a professional HR response.`;

  const reply = await callGemini(
    prompt,
    systemInstruction
  );

  return (
    reply ||
    "Data not available in Library, check alternate source below.\nSystem is currently unavailable. Please try again later."
  );
}

// ─────────────────────────────────────────────
// API HANDLER
// ─────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      answer: "Method not allowed."
    });
  }

  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        answer: "GEMINI_API_KEY environment variable is missing."
      });
    }

    if (!process.env.NOTION_API_KEY) {
      return res.status(500).json({
        answer: "NOTION_API_KEY environment variable is missing."
      });
    }

    const { message } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({
        answer: "Please enter a question."
      });
    }

    const docs = await searchNotionDocuments(message);

    let context = "";

    if (docs.length > 0) {
      const raw = docs
        .slice(0, 5)
        .map(
          (d) =>
            `TITLE: ${d.title}\nCONTENT: ${d.content}`
        )
        .join("\n\n");

      if (await isContextRelevant(message, raw)) {
        context = raw;
      }
    }

    const answer = await askGemini(
      message,
      context
    );

    return res.status(200).json({
      answer
    });
  } catch (error) {
    console.error("SERVER ERROR:", error);

    return res.status(500).json({
      answer:
        "System error occurred. Please check Vercel logs."
    });
  }
}
