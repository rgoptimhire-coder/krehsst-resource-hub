import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const NOTION_VERSION = "2022-06-28";

const MODELS = [
  "gemini-3.1-pro",
  "gemini-3-flash",
  "gemini-2.5-pro"
];

// ======================
// NOTION HELPERS
// ======================

function getPlainText(richText = []) {
  return richText.map(t => t.plain_text || "").join("");
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

function blockToText(block) {
  const type = block.type;
  const data = block[type];

  if (!data) return "";

  if (data.rich_text) {
    return getPlainText(data.rich_text);
  }

  return "";
}

async function getBlockChildren(blockId) {
  let blocks = [];
  let cursor = null;

  do {
    const url = new URL(
      `https://api.notion.com/v1/blocks/${blockId}/children`
    );

    url.searchParams.set("page_size", "100");

    if (cursor) {
      url.searchParams.set("start_cursor", cursor);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION
      }
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("NOTION BLOCK ERROR:", data);
      throw new Error(data.message || "Notion block read failed");
    }

    blocks.push(...data.results);

    cursor = data.next_cursor;
  } while (cursor);

  return blocks;
}

async function readPageContent(blockId, depth = 0) {
  if (depth > 2) return "";

  let content = "";

  const blocks = await getBlockChildren(blockId);

  for (const block of blocks) {
    content += blockToText(block) + "\n";

    if (block.has_children) {
      content += await readPageContent(block.id, depth + 1);
    }
  }

  return content;
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

    const docs = [];

    for (const page of data.results || []) {
      try {
        const content = await readPageContent(page.id);

        docs.push({
          title: getPageTitle(page),
          content: content.substring(0, 1500)
        });
      } catch (err) {
        console.error("PAGE READ ERROR:", err);
      }
    }

    return docs;
  } catch (err) {
    console.error("NOTION SEARCH FAILED:", err);
    return [];
  }
}

// ======================
// GEMINI HELPERS
// ======================

async function callGemini(prompt, systemInstruction = "") {
  for (const modelName of MODELS) {
    try {
      console.log(`Trying Gemini Model: ${modelName}`);

      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction
      });

      const result = await model.generateContent(prompt);

      const text = result.response.text();

      console.log(`SUCCESS: ${modelName}`);

      if (text?.trim()) {
        return text;
      }
    } catch (err) {
      console.error(`FAILED MODEL: ${modelName}`);
      console.error(err);
    }
  }

  return null;
}

async function isContextRelevant(userMessage, docsContext) {
  const response = await callGemini(
    `
User Query:
${userMessage}

Documents:
${docsContext}

Reply ONLY YES or NO.
`,
    "Reply only YES or NO."
  );

  return response?.trim().toUpperCase().startsWith("YES");
}

async function askGemini(userMessage, companyContext) {
  const prompt =
    companyContext && companyContext.length > 0
      ? `
INTERNAL KNOWLEDGE:

${companyContext}

QUESTION:
${userMessage}

Answer using the internal knowledge first.
`
      : `
QUESTION:
${userMessage}

No internal knowledge found.
Provide a professional HR response.
`;

  const answer = await callGemini(
    prompt,
    "You are KREHSST Resource Hub HR Assistant."
  );

  return answer;
}

// ======================
// API HANDLER
// ======================

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        answer: "Method not allowed."
      });
    }

    console.log(
      "GEMINI KEY EXISTS:",
      !!process.env.GEMINI_API_KEY
    );

    console.log(
      "NOTION KEY EXISTS:",
      !!process.env.NOTION_API_KEY
    );

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        answer: "Missing GEMINI_API_KEY."
      });
    }

    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        answer: "Please enter a question."
      });
    }

    let context = "";

    if (process.env.NOTION_API_KEY) {
      const docs = await searchNotionDocuments(message);

      if (docs.length > 0) {
        const combined = docs
          .slice(0, 5)
          .map(
            d =>
              `TITLE: ${d.title}\nCONTENT:\n${d.content}`
          )
          .join("\n\n");

        const relevant = await isContextRelevant(
          message,
          combined
        );

        if (relevant) {
          context = combined;
        }
      }
    }

    const answer = await askGemini(message, context);

    if (!answer) {
      return res.status(500).json({
        answer:
          "Gemini did not return a response. Check Vercel Function Logs."
      });
    }

    return res.status(200).json({
      answer
    });
  } catch (err) {
    console.error("SERVER ERROR:", err);

    return res.status(500).json({
      answer: `Server Error: ${err.message}`
    });
  }
}
