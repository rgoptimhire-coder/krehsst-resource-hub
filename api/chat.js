import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const NOTION_VERSION = "2022-06-28";

const GEMINI_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3-flash",
  "gemini-2.5-flash"
];

function getPlainText(richText = []) {
  return richText.map(t => t.plain_text || "").join("");
}

function blockToText(block) {
  const type = block.type;
  const data = block[type];

  if (!data) return "";

  if (data.rich_text) {
    return getPlainText(data.rich_text);
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
    const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
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
      const childText = await readPageContent(block.id, depth + 1);
      if (childText) {
        text += childText + "\n";
      }
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
      filter: {
        property: "object",
        value: "page"
      }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Notion search failed.");
  }

  if (!data.results || data.results.length === 0) {
    return "";
  }

  let finalText = "";

  for (const page of data.results) {
    const title = getPageTitle(page);
    const content = await readPageContent(page.id);

    if (content.trim()) {
      finalText += `
DOCUMENT TITLE: ${title}
DOCUMENT URL: ${page.url}

DOCUMENT CONTENT:
${content}
-----------------------------
`;
    }
  }

  return finalText;
}

async function generateWithFallback(prompt) {
  let lastError;

  for (const modelName of GEMINI_MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName
      });

      const result = await model.generateContent(prompt);
      const response = await result.response;

      return response.text();

    } catch (error) {
      lastError = error;
      console.log(`Gemini model failed: ${modelName}`, error.message);
    }
  }

  throw lastError;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        answer: "Only POST method is allowed."
      });
    }

    const { message } = req.body || {};

    if (!message || !message.trim()) {
      return res.status(400).json({
        answer: "Please type a keyword or question."
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        answer: "Missing GEMINI_API_KEY in Vercel environment variables."
      });
    }

    if (!process.env.NOTION_API_KEY) {
      return res.status(500).json({
        answer: "Missing NOTION_API_KEY in Vercel environment variables."
      });
    }

    const notionContent = await searchNotionDocuments(message);

    if (!notionContent.trim()) {
      return res.status(200).json({
        answer: "Not found in Notion documents."
      });
    }

    const prompt = `
You are KREHSST Knowledge Assistant.

STRICT RULES:
1. Use ONLY the Notion document content provided below.
2. Do NOT use general knowledge.
3. Do NOT guess.
4. If the answer is not available in the Notion content, reply exactly:
"Not found in Notion documents."
5. Mention the matching document title when useful.
6. Keep the answer clear and professional.

NOTION DOCUMENTS:
${notionContent.slice(0, 25000)}

USER QUESTION:
${message}
`;

    const answer = await generateWithFallback(prompt);

    return res.status(200).json({
      answer
    });

  } catch (error) {
    return res.status(500).json({
      answer: "Backend error: " + error.message
    });
  }
}
