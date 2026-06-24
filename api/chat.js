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
        page_size: 5,
        filter: {
          property: "object",
          value: "page"
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Notion search failed.");
  }

  if (!data.results?.length) {
    return [];
  }

  const docs = [];

  for (const page of data.results) {

    const title = getPageTitle(page);

    const content = await readPageContent(page.id);

    docs.push({
      title,
      url: page.url,
      content
    });
  }

  return docs;
}

async function askGemini(prompt) {

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash"
  });

  const result = await model.generateContent(prompt);

  return result.response.text();
}

export default async function handler(req, res) {

  try {

    if (req.method !== "POST") {
      return res.status(405).json({
        answer: "Only POST requests are allowed."
      });
    }

    const { message } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({
        answer: "Please enter a question."
      });
    }

    const docs = await searchNotionDocuments(message);

    if (docs.length === 0) {

      const externalAnswer = await askGemini(`
You are KREHSST Resource Hub Assistant.

The user's question was not found in company documents.

Answer in simple professional language.

Rules:
- Maximum 80 words
- No markdown
- No stars
- No emojis
- No special symbols
- Keep answer concise

Format exactly:

Topic: <Topic>

Answer:
<Short answer>

Additional Guidance:
1. First recommendation
2. Second recommendation
3. Third recommendation

Note:
This information was not found in KREHSST documents and is based on general industry practices.

Question:
${message}
`);

      return res.status(200).json({
        answer: externalAnswer
      });
    }

    const knowledge = docs.map(doc => `
DOCUMENT TITLE:
${doc.title}

CONTENT:
${doc.content}
    `).join("\n\n");

    const answer = await askGemini(`
You are KREHSST Resource Hub Assistant.

Your role is to help employees understand company policies.

Use only the provided documents.

Rules:

- Never copy document content.
- Never show policy clauses.
- Never dump document text.
- Summarize only.
- Maximum 80 words.
- Mention source document.
- No markdown.
- No stars.
- No emojis.
- No special symbols.
- No bullet points.
- Use simple HR language.

Return response exactly like this:

Topic: <Topic>

Answer:
<2 to 4 short sentences>

Key Information:
1. First point
2. Second point
3. Third point
4. Fourth point

Source:
<Document Name>

DOCUMENTS:

${knowledge.substring(0,25000)}

QUESTION:

${message}
`);

    return res.status(200).json({
      answer
    });

  } catch (error) {

    return res.status(500).json({
      answer: "Error: " + error.message
    });
  }
}
